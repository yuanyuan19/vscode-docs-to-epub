const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const pLimit = require('p-limit').default || require('p-limit');
require('dotenv').config();

// ==================== 配置 ====================
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai'; // 'openai' | 'anthropic' | 'custom'
const TARGET_LANGUAGE = process.env.TARGET_LANGUAGE || 'zh-CN';
const TRANSLATED_DIR = path.join(__dirname, '../docs-translated');
const CACHE_DIR = path.join(__dirname, '../.translation-cache');

// 并发配置
const CONCURRENT_FILES = parseInt(process.env.CONCURRENT_FILES || '3');
const CONCURRENT_CHUNKS = parseInt(process.env.CONCURRENT_CHUNKS || '2');
const DELAY_BETWEEN_FILES = parseInt(process.env.DELAY_BETWEEN_FILES || '500');
const DELAY_BETWEEN_CHUNKS = parseInt(process.env.DELAY_BETWEEN_CHUNKS || '200');

// ==================== 初始化 LLM 客户端 ====================
let llmClient;
let anthropicClient;

if (LLM_PROVIDER === 'openai') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('请设置 OPENAI_API_KEY 环境变量');
  }
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  llmClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: baseURL, // 支持自定义 API 地址
  });
} else if (LLM_PROVIDER === 'anthropic') {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('请设置 ANTHROPIC_API_KEY 环境变量');
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL || undefined;
  anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: baseURL, // 支持自定义 API 地址
  });
} else if (LLM_PROVIDER === 'custom') {
  if (!process.env.CUSTOM_API_URL) {
    throw new Error('请设置 CUSTOM_API_URL 环境变量');
  }
}

// ==================== 自定义 API 调用函数 ====================
async function callCustomAPI(prompt, systemPrompt) {
  const apiUrl = process.env.CUSTOM_API_URL;
  const apiKey = process.env.CUSTOM_API_KEY || '';
  const model = process.env.CUSTOM_MODEL || 'default';

  // 支持多种自定义 API 格式
  const requestBody = process.env.CUSTOM_API_FORMAT === 'openai' ? {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    temperature: parseFloat(process.env.CUSTOM_TEMPERATURE || '0.3'),
    max_tokens: parseInt(process.env.CUSTOM_MAX_TOKENS || '4000')
  } : process.env.CUSTOM_API_FORMAT === 'anthropic' ? {
    model: model,
    max_tokens: parseInt(process.env.CUSTOM_MAX_TOKENS || '4096'),
    messages: [
      { role: 'user', content: `${systemPrompt}\n\n${prompt}` }
    ]
  } : {
    // 通用格式，从环境变量读取
    prompt: prompt,
    system: systemPrompt,
    model: model,
    ...JSON.parse(process.env.CUSTOM_API_BODY || '{}')
  };

  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
    ...JSON.parse(process.env.CUSTOM_API_HEADERS || '{}')
  };

  try {
    const response = await axios.post(apiUrl, requestBody, { headers });

    // 支持多种响应格式
    if (process.env.CUSTOM_API_FORMAT === 'openai') {
      return response.data.choices[0].message.content.trim();
    } else if (process.env.CUSTOM_API_FORMAT === 'anthropic') {
      return response.data.content[0].text.trim();
    } else {
      // 自定义响应路径
      const responsePath = process.env.CUSTOM_API_RESPONSE_PATH || 'data.choices[0].message.content';
      const paths = responsePath.split('.');
      let result = response.data;
      for (const p of paths) {
        const match = p.match(/^(\w+)\[(\d+)\]$/);
        if (match) {
          result = result[match[1]][parseInt(match[2])];
        } else {
          result = result[p];
        }
      }
      return String(result).trim();
    }
  } catch (error) {
    throw new Error(`自定义 API 调用失败: ${error.message}`);
  }
}

// ==================== 翻译文本 ====================
async function translateText(text, filePath, chunkIndex, totalChunks) {
  const prompt = `你是一个专业的文档翻译专家。请将以下 Markdown 文档内容翻译成 ${TARGET_LANGUAGE}。

要求：
1. 保持 Markdown 格式不变（标题、代码块、链接等）
2. 保持代码块中的代码不变，只翻译注释
3. 保持图片链接和格式不变
4. 保持技术术语的准确性
5. 翻译要自然流畅，符合中文表达习惯

${totalChunks > 1 ? `这是第 ${chunkIndex}/${totalChunks} 部分。` : ''}

原文：
${text}`;

  const systemPrompt = '你是一个专业的 Markdown 文档翻译专家，擅长保持格式和代码不变。';

  try {
    if (LLM_PROVIDER === 'openai') {
      const response = await llmClient.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.3'),
        max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '4000')
      });
      return response.choices[0].message.content.trim();

    } else if (LLM_PROVIDER === 'anthropic') {
      const response = await anthropicClient.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096'),
        messages: [
          { role: 'user', content: `${systemPrompt}\n\n${prompt}` }
        ]
      });
      return response.content[0].text.trim();

    } else if (LLM_PROVIDER === 'custom') {
      return await callCustomAPI(prompt, systemPrompt);
    }
  } catch (error) {
    console.error(`❌ 翻译失败 (${filePath}, chunk ${chunkIndex}):`, error.message);
    throw error;
  }
}

// ==================== 分块 Markdown ====================
function splitMarkdownIntoChunks(content, maxChunkSize = 3000) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const line of lines) {
    const lineSize = line.length;

    if (line.startsWith('#') && currentSize > maxChunkSize * 0.7) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [];
        currentSize = 0;
      }
    }

    currentChunk.push(line);
    currentSize += lineSize;

    if (currentSize > maxChunkSize) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
      currentSize = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }

  return chunks.length > 0 ? chunks : [content];
}

// ==================== 翻译单个文件 ====================
async function translateMarkdown(filePath, targetPath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // 检查缓存
  const cacheKey = path.relative(__dirname, filePath);
  const cachePath = path.join(CACHE_DIR, cacheKey.replace(/\//g, '_') + '.json');

  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.originalHash === hashContent(content) && cached.translated) {
      console.log(`📦 使用缓存: ${path.basename(filePath)}`);
      return cached.translated;
    }
  }

  // 分离 front matter 和内容
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  let frontMatter = '';
  let markdownContent = content;

  if (frontMatterMatch) {
    frontMatter = frontMatterMatch[1];
    markdownContent = frontMatterMatch[2];
  }

  // 分块翻译
  const chunks = splitMarkdownIntoChunks(markdownContent);
  console.log(`🔄 翻译中: ${path.basename(filePath)} (${chunks.length} 块)`);

  // 并发翻译 chunks
  const chunkLimit = pLimit(CONCURRENT_CHUNKS);
  const chunkPromises = chunks.map((chunk, i) =>
    chunkLimit(async () => {
      const translated = await translateText(chunk, filePath, i + 1, chunks.length);
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHUNKS));
      }
      return translated;
    })
  );

  const translatedChunks = await Promise.all(chunkPromises);
  const translatedContent = translatedChunks.join('\n\n');

  // 重新组合 front matter 和翻译后的内容
  let finalContent = '';
  if (frontMatter) {
    const metaDescMatch = frontMatter.match(/MetaDescription:\s*(.+)/);
    if (metaDescMatch) {
      try {
        const translatedMeta = await translateText(metaDescMatch[1], filePath, 0, 0);
        frontMatter = frontMatter.replace(/MetaDescription:\s*(.+)/, `MetaDescription: ${translatedMeta}`);
      } catch (error) {
        console.warn(`⚠️  翻译 MetaDescription 失败，保留原文`);
      }
    }
    finalContent = `---\n${frontMatter}\n---\n\n${translatedContent}`;
  } else {
    finalContent = translatedContent;
  }

  // 保存缓存
  if (!fs.existsSync(path.dirname(cachePath))) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  }
  fs.writeFileSync(cachePath, JSON.stringify({
    originalHash: hashContent(content),
    translated: finalContent
  }, null, 2));

  return finalContent;
}

// ==================== 工具函数 ====================
function hashContent(content) {
  return require('crypto').createHash('md5').update(content).digest('hex');
}

function collectFiles(tocPath, baseDir) {
  const toc = JSON.parse(fs.readFileSync(tocPath, 'utf8'));
  const files = [];

  function traverseTopics(topics) {
    topics.forEach(topic => {
      if (Array.isArray(topic) && topic.length >= 2) {
        const [title, filePath] = topic;
        if (title && filePath) {
          const mdPath = path.join(baseDir, filePath.replace('/docs/', '') + '.md');
          if (fs.existsSync(mdPath)) {
            files.push({
              title,
              path: mdPath,
              relativePath: filePath.replace('/docs/', '')
            });
          }
        }
        if (topic.length === 3 && typeof topic[2] === 'object' && topic[2].topics) {
          traverseTopics(topic[2].topics);
        }
      }
    });
  }

  toc.forEach(section => {
    if (section.topics) {
      traverseTopics(section.topics);
    }
  });

  return files;
}

// ==================== 主函数 ====================
async function translateAll() {
  console.log('🚀 开始翻译文档...');
  console.log(`📝 目标语言: ${TARGET_LANGUAGE}`);
  console.log(`🤖 LLM 提供商: ${LLM_PROVIDER}`);
  console.log(`⚡ 并发配置: ${CONCURRENT_FILES} 个文件, ${CONCURRENT_CHUNKS} 个块/文件\n`);

  const docsDir = path.join(__dirname, '../docs');
  const tocPath = path.join(docsDir, 'toc.json');

  if (!fs.existsSync(tocPath)) {
    throw new Error(`找不到 toc.json: ${tocPath}`);
  }

  // 创建输出目录
  if (!fs.existsSync(TRANSLATED_DIR)) {
    fs.mkdirSync(TRANSLATED_DIR, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const files = collectFiles(tocPath, docsDir);
  console.log(`📚 找到 ${files.length} 个文档文件\n`);

  // 复制 toc.json
  fs.copyFileSync(tocPath, path.join(TRANSLATED_DIR, 'toc.json'));

  // 并发翻译文件
  const fileLimit = pLimit(CONCURRENT_FILES);
  const startTime = Date.now();

  const filePromises = files.map((file, i) =>
    fileLimit(async () => {
      const outputPath = path.join(TRANSLATED_DIR, file.relativePath + '.md');
      const outputDir = path.dirname(outputPath);

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      try {
        const translated = await translateMarkdown(file.path, outputPath);
        fs.writeFileSync(outputPath, translated, 'utf8');
        console.log(`✅ [${i + 1}/${files.length}] ${file.title}`);

        if (i < files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_FILES));
        }
      } catch (error) {
        console.error(`❌ 翻译失败: ${file.path}`, error.message);
        // 失败时复制原文
        fs.copyFileSync(file.path, outputPath);
      }
    })
  );

  await Promise.all(filePromises);

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  console.log(`\n✨ 翻译完成！`);
  console.log(`📁 文件保存在: ${TRANSLATED_DIR}`);
  console.log(`⏱️  总耗时: ${duration} 分钟`);
}

// ==================== 运行 ====================
if (require.main === module) {
  translateAll().catch(error => {
    console.error('❌ 翻译过程出错:', error);
    process.exit(1);
  });
}

module.exports = { translateAll, translateMarkdown };