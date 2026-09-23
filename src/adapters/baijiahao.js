/**
 * 百家号适配器。
 *
 * ⚠ 本文件的 DOM 假设**全部未经实测**（T-OPEN-33 前置 P-2 五项事实都还没有答案）。
 * 它们被写成一张可整体替换的表，就是为了 spike 时只改这里：
 *   1. 作者后台登录页与发文页地址；
 *   2. 标题输入框、正文编辑器、封面与配图上传入口的选择器；
 *   3. 发布成功后可稳定取到的文章 URL 形态。
 * 选择器取不到时一律判 `page_changed` 并停住（需求 §十一），
 * 不猜第二个候选、不点"看起来像"的按钮 —— 平台改版时最坏的结果是重复发布出去一篇错稿。
 */
const ENTRY = {
  home: 'https://baijiahao.baidu.com/',
  login: 'https://baijiahao.baidu.com/',
  // 图文发表入口。实际地址带动态参数，因此这里只作为导航起点，
  // 真正的编辑器入口要靠页面上的按钮进入。
  publish: 'https://baijiahao.baidu.com/builder/editor/content/edit/publish_type/article',
};

const SELECTORS = {
  coverUpload: 'input[type=file]',
  loginEntry: 'text=登录',
  publishButton: 'text=发布',
  titleInput: 'input[placeholder*="标题"]',
  // 百家号编辑器内核候选（未实测）。contenteditable 兜底是为了让 spike 能一眼看出
  // 是"没有编辑器"还是"编辑器不是这个类名"。
  bodyEditor: '[contenteditable="true"], .editor-content, .ql-editor',
};

export const baijiahaoAdapter = {
  code: 'baijiahao',
  homeUrl: ENTRY.home,
  implemented: true,
  // 登录判定用的百度主凭证 cookie。⚠ 名称未实测：判错的后果只是"自动 connected 不来"，
  // 人工点「我已完成登录」那条路不依赖这张表（见 sessions.confirmLogin）。
  loginCookies: ['BDUSS'],
  modes: ['manual_confirm'],
  selectors: SELECTORS,
  supportsImageUpload: true,
  supportsLongBody: true,

  async openHome(page) {
    await page.goto(ENTRY.home, { timeout: 45_000, waitUntil: 'domcontentloaded' });
  },

  async openLogin(page) {
    await page.goto(ENTRY.login, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  },

  async openEditor(page) {
    await page.goto(ENTRY.publish, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  },

  /**
   * 填写一篇稿。
   *
   * 只填不发（需求 §六 一期口径）：填完停在编辑页等用户自己点「发布」。
   * 返回页面上实际命中的入口数量，供作业记录留证。
   */
  async fillArticle(page, { images = [], title, contentHtml }) {
    const filled = { cover: false, images: 0, text: false, title: false };

    const titleLocator = page.locator(SELECTORS.titleInput).first();
    await requireFound(titleLocator, 'title_input');
    await titleLocator.click();
    // 直接 fill 富文本平台的标题框比逐键打字稳：不会触发拼写联想浮层。
    await titleLocator.fill(title);
    filled.title = true;

    const body = page.locator(SELECTORS.bodyEditor).first();
    await requireFound(body, 'body_editor');
    await body.click();
    // 正文只能整段注入：合成 keydown 打不进富文本编辑器，中文尤其如此。
    // 注入点位于**已登录的平台页面**内，是本项目里最坏的 XSS 落点。载荷虽然已在 GEO 侧
    // 经 MarkdownPublicationRenderer 转义，这里仍独立再净化一遍（DOMParser 解析 →
    // 删危险节点 → 剥 on* 与 javascript:），不把安全性寄托在"上游一定没错"上。
    // 净化逻辑必须整段写在 evaluate 里：它在页面上下文执行，带不走 Node 侧的函数。
    await body.evaluate((element, html) => {
      const forbidden = new Set([
        'BASE', 'EMBED', 'FORM', 'IFRAME', 'LINK', 'META', 'OBJECT', 'SCRIPT', 'STYLE',
      ]);
      const doc = new DOMParser().parseFromString(`<div id="__geo_root">${html}</div>`, 'text/html');
      const root = doc.getElementById('__geo_root');
      const scrub = (node) => {
        for (const child of [...node.children]) {
          if (forbidden.has(child.tagName)) {
            child.remove();
            continue;
          }
          for (const attribute of [...child.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.replace(/\s+/g, '').toLowerCase();
            const dangerousUrl
              = name.startsWith('src')
                || name === 'href'
                || name === 'xlink:href'
                || name === 'action'
                || name === 'data';
            if (name.startsWith('on') || (dangerousUrl && value.startsWith('javascript:'))) {
              child.removeAttribute(attribute.name);
            }
          }
          scrub(child);
        }
      };
      scrub(root);
      element.innerHTML = root.innerHTML;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, contentHtml);
    filled.text = true;

    if (images.length > 0) {
      const upload = page.locator(SELECTORS.coverUpload).first();
      if (await upload.count().catch(() => 0)) {
        // setInputFiles 只吃本地路径，作业层已把 base64 落到临时文件。
        await upload.setInputFiles(images.map((image) => image.tempPath));
        filled.cover = true;
        filled.images = images.length;
      }
      // 找不到上传入口不判失败：一期允许无图发布，由界面提示承担。
    }

    return filled;
  },

  /**
   * 平台侧是否已经真的发布出去。
   *
   * 只认两种确定证据：出现文章管理里的新条目，或 URL 变成带文章 id 的形态。
   * 两者都没有时返回 unknown，让上层按"结果未知"落库（不判成功、不自动重发）。
   */
  async inspectResult(page) {
    const url = page.url();
    const match = /https:\/\/baijiahao\.baidu\.com\/s\?id=\d+/.exec(url);
    if (match) return { resultUrl: match[0], status: 'succeeded' };
    return { resultUrl: null, status: 'unknown' };
  },

  /** 是否已经登录：只看有没有落到作者后台，不猜中间态。 */
  async isLoggedIn(page) {
    await page.goto(ENTRY.home, { timeout: 45_000, waitUntil: 'domcontentloaded' });
    const url = page.url();
    if (/builder\/(pc)?[_-]?home|\/np\/biz-home/.test(url)) return true;
    return !(await page.locator(SELECTORS.loginEntry).first().count().catch(() => 0));
  },
};

async function requireFound(locator, slot) {
  const count = await locator.count().catch(() => 0);
  if (count > 0) return;
  const error = new Error(`百家号页面缺少预期元素: ${slot}`);
  error.failClass = 'page_changed';
  throw error;
}

export { ENTRY };
