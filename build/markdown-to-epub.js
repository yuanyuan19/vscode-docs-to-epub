const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 使用翻译后的目录
const TRANSLATED_DIR = path.join(__dirname, '../docs-translated');
const DOCS_DIR = path.join(__dirname, '../docs');
const USE_TRANSLATED = process.env.USE_TRANSLATED !== 'false';

function collectDocs(tocPath, baseDir) {
  const toc = JSON.parse(fs.readFileSync(tocPath, 'utf8'));
  const files = [];

  function traverseTopics(topics, sectionName = '') {
    topics.forEach(topic => {
      if (Array.isArray(topic) && topic.length >= 2) {
        const [title, filePath] = topic;
        if (title && filePath) {
          const mdPath = path.join(baseDir, filePath.replace('/docs/', '') + '.md');
          if (fs.existsSync(mdPath)) {
            files.push({
              title,
              path: mdPath,
              section: sectionName,
              dir: path.dirname(mdPath)
            });
          }
        }
        if (topic.length === 3 && typeof topic[2] === 'object' && topic[2].topics) {
          const subsectionName = topic[2].name || sectionName;
          traverseTopics(topic[2].topics, subsectionName);
        }
      }
    });
  }

  toc.forEach(section => {
    if (section.topics) {
      traverseTopics(section.topics, section.name);
    }
  });

  return files;
}

// 移除 front matter 的辅助函数
function removeFrontMatter(content) {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n\n?/;
  return content.replace(frontMatterRegex, '');
}

// 清理可能导致问题的内容
function sanitizeContent(content) {
  content = removeFrontMatter(content);

  // 移除文件中的第一个 H1 标题（因为我们会用 toc.json 中的 title 作为标题）
  // 匹配第一个 # 开头的标题行
  content = content.replace(/^#\s+.+$/m, '');

  // 清理多余的空白行
  content = content.replace(/\n{3,}/g, '\n\n');

  // 将单独的 --- 行替换为分隔线
  content = content.replace(/^---\s*$/gm, '***');

  // 转义可能导致数学公式误识别的内容（在表格中）
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = [];
  let codeBlockIndex = 0;

  // 临时替换代码块
  content = content.replace(codeBlockRegex, (match) => {
    const placeholder = `__CODE_BLOCK_${codeBlockIndex}__`;
    codeBlocks[codeBlockIndex] = match;
    codeBlockIndex++;
    return placeholder;
  });

  // 转义表格中的 {config:...} 等模式
  content = content.replace(/(\|[^|]*)\{([^}]+)\}([^|]*\|)/g, (match, before, middle, after) => {
    return before + '\\{' + middle + '\\}' + after;
  });

  // 恢复代码块
  codeBlocks.forEach((block, index) => {
    content = content.replace(`__CODE_BLOCK_${index}__`, block);
  });

  // 清理可能导致问题的特殊字符（保留基本 Unicode）
  content = content.replace(/[\u200B-\u200D\uFEFF]/g, '');

  return content.trim();
}

// 收集所有资源路径
function collectResourcePaths(baseDir, files) {
  const resourcePaths = new Set();

  resourcePaths.add(path.join(__dirname, '..'));
  resourcePaths.add(baseDir);

  files.forEach(file => {
    resourcePaths.add(file.dir);
  });

  const rootImages = path.join(__dirname, '../images');
  if (fs.existsSync(rootImages)) {
    resourcePaths.add(rootImages);
  }

  function findImageDirs(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.forEach(entry => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'images') {
            resourcePaths.add(fullPath);
            resourcePaths.add(dir);
          }
          findImageDirs(fullPath);
        }
      });
    } catch (err) {
      // 忽略无法访问的目录
    }
  }

  findImageDirs(baseDir);

  if (baseDir !== DOCS_DIR) {
    findImageDirs(DOCS_DIR);
    resourcePaths.add(DOCS_DIR);
  }

  return Array.from(resourcePaths);
}

// 验证 EPUB 文件
function validateEPUB(filePath) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: '文件不存在' };
  }

  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: '文件为空' };
  }

  try {
    const fileContent = fs.readFileSync(filePath, { encoding: null });
    const zipSignature = fileContent.slice(0, 2);
    if (zipSignature[0] !== 0x50 || zipSignature[1] !== 0x4B) {
      return { valid: false, error: '不是有效的 ZIP/EPUB 文件' };
    }
  } catch (err) {
    return { valid: false, error: `无法读取文件: ${err.message}` };
  }

  return { valid: true, size: stats.size };
}

function generateEPUB() {
  const baseDir = USE_TRANSLATED && fs.existsSync(TRANSLATED_DIR) ? TRANSLATED_DIR : DOCS_DIR;
  const tocPath = path.join(baseDir, 'toc.json');
  const outputPath = path.join(__dirname, `../vscode-docs${USE_TRANSLATED ? '-translated' : ''}.epub`);

  if (!fs.existsSync(tocPath)) {
    const originalToc = path.join(DOCS_DIR, 'toc.json');
    if (fs.existsSync(originalToc)) {
      fs.copyFileSync(originalToc, tocPath);
    }
  }

  console.log(`使用目录: ${baseDir}`);
  console.log('收集文档文件...');
  const files = collectDocs(tocPath, baseDir);
  console.log(`找到 ${files.length} 个文档文件`);

  console.log('收集资源路径...');
  const resourcePaths = collectResourcePaths(baseDir, files);
  console.log(`找到 ${resourcePaths.length} 个资源路径`);

  const tempDir = path.join(__dirname, '../_epub_temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const combinedMd = path.join(tempDir, 'combined.md');

  let content = `# Visual Studio Code Documentation${USE_TRANSLATED ? ' (翻译版)' : ''}\n\n`;
  content += `*Generated from vscode-docs repository*\n\n`;
  content += `**Total Chapters: ${files.length}**\n\n`;
  content += '***\n\n';

  let currentSection = '';
  files.forEach((file, index) => {
    if (file.section !== currentSection) {
      content += `\n# ${file.section}\n\n`;
      currentSection = file.section;
    }

    // 使用 toc.json 中的 title 作为 H2 标题，确保层级正确
    content += `\n## ${file.title}\n\n`;

    try {
      let fileContent = fs.readFileSync(file.path, 'utf8');
      fileContent = sanitizeContent(fileContent);
      content += fileContent + '\n\n';

      if (index < files.length - 1) {
        content += '***\n\n';
      }
    } catch (err) {
      console.warn(`警告: 无法读取 ${file.path}: ${err.message}`);
    }
  });

  fs.writeFileSync(combinedMd, content, 'utf8');
  console.log('Markdown 文件已合并');

  const combinedStats = fs.statSync(combinedMd);
  console.log(`合并后的 Markdown 大小: ${(combinedStats.size / 1024 / 1024).toFixed(2)} MB`);

  console.log('开始转换为 EPUB...');
  const coverImage = path.join(__dirname, '../images/logo-stable.png');
  const coverFlag = fs.existsSync(coverImage) ? `--epub-cover="${coverImage}"` : '';

  const resourcePathStr = resourcePaths
    .map(p => path.resolve(p))
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .join(path.delimiter);

  const pandocCmd = `pandoc "${combinedMd}" -o "${outputPath}" ` +
    `--from markdown-yaml_metadata_block-tex_math_dollars ` +
    `--to epub3 ` +
    `--resource-path="${resourcePathStr}" ` +
    `${coverFlag} ` +
    `--toc --toc-depth=2 ` +
    `--epub-chapter-level=2 ` +
    `--metadata title="Visual Studio Code Documentation${USE_TRANSLATED ? ' (翻译版)' : ''}" ` +
    `--metadata author="Microsoft Corporation" ` +
    `--metadata language=${process.env.TARGET_LANGUAGE || 'zh-CN'}`;

  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    execSync(pandocCmd, { stdio: 'inherit' });

    console.log('\n验证 EPUB 文件...');
    const validation = validateEPUB(outputPath);

    if (validation.valid) {
      const sizeMB = (validation.size / 1024 / 1024).toFixed(2);
      console.log(`\n✅ EPUB 文件已生成: ${outputPath}`);
      console.log(`📦 文件大小: ${sizeMB} MB`);
      console.log(`✅ 文件验证通过`);
    } else {
      console.error(`\n❌ EPUB 文件验证失败: ${validation.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ 转换失败:', err.message);
    console.error(`\n💡 提示: 临时文件保存在 ${tempDir}，可以检查合并后的 Markdown 文件`);
    process.exit(1);
  } finally {
    // 注释掉自动删除，方便调试
    // if (fs.existsSync(tempDir)) {
    //   fs.rmSync(tempDir, { recursive: true, force: true });
    // }
  }
}

generateEPUB();