/**
 * 今日头条（头条号）适配器。
 *
 * ⚠ 与百家号同一口径：入口里**只有登录页与作者后台是查证过的**
 * （`https://mp.toutiao.com/auth/page/login/` 与 `https://mp.toutiao.com/profile_v4/`）。
 * 发文编辑器地址、标题框与正文容器选择器**全部未实测**（T-OPEN-33 前置 P-2 五项事实）。
 * 它们写成一张可整体替换的表，spike 时只改这里；取不到一律判 `page_changed` 停住，
 * 不猜第二个候选 —— 平台改版时最坏的结果是重复发出去一篇错稿。
 */
const ENTRY = {
  home: 'https://mp.toutiao.com/profile_v4/',
  login: 'https://mp.toutiao.com/auth/page/login/',
  // 未实测：发文入口。真机确认后只改这一行。
  publish: 'https://mp.toutiao.com/profile_v4/graph-pub',
};

const SELECTORS = {
  bodyEditor: '[contenteditable="true"], .ql-editor, .ProseMirror',
  coverUpload: 'input[type=file]',
  // 未登录时页面上必然出现的登录入口（比 URL 更稳：登录墙有时不改地址）。
  loginEntry: 'text=登录',
  publishButton: 'text=发布',
  titleInput: 'input[placeholder*="标题"]',
};

export const toutiaoAdapter = {
  code: 'toutiao',
  homeUrl: ENTRY.home,
  implemented: true,
  // ⚠ cookie 名未实测，判错只影响自动 connected，不影响人工确认那条路。
  loginCookies: ['sessionid', 'sid_guard'],
  modes: ['manual_confirm'],
  selectors: SELECTORS,
  supportsImageUpload: true,
  supportsLongBody: true,

  async openHome(page) {
    await page.goto(ENTRY.home, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  },

  async openLogin(page) {
    await page.goto(ENTRY.login, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  },

  async openEditor(page) {
    await page.goto(ENTRY.publish, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  },

  /**
   * 填一篇稿，填完就停（需求 §六 一期口径、N-10）。
   *
   * 正文注入前在页面上下文里再净化一遍：注入点位于**已登录的平台页面**内，
   * 这是本项目最坏的 XSS 落点，不能把安全性寄托在"上游一定转义过"上。
   * 逻辑必须整段写在 evaluate 里 —— 它在页面上下文执行，带不走 Node 侧的函数。
   */
  async fillArticle(page, { images = [], title, contentHtml }) {
    const filled = { cover: false, images: 0, text: false, title: false };

    const titleLocator = page.locator(SELECTORS.titleInput).first();
    await requireFound(titleLocator, 'title_input');
    await titleLocator.click();
    await titleLocator.fill(title);
    filled.title = true;

    const body = page.locator(SELECTORS.bodyEditor).first();
    await requireFound(body, 'body_editor');
    await body.click();
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
        await upload.setInputFiles(images.map((image) => image.tempPath));
        filled.cover = true;
        filled.images = images.length;
      }
      // 找不到上传入口不判失败：一期允许无图发布，由界面提示承担。
    }

    return filled;
  },

  /**
   * 只认确定证据：文章详情页 URL（`www.toutiao.com/article/<数字 id>/`）。
   * 拿不到就返回 unknown，由 GEO 侧按"结果未知"落库且不给重试入口（N-06、GEO-42708）。
   */
  async inspectResult(page) {
    const match = /https:\/\/www\.toutiao\.com\/article\/\d+\//.exec(page.url());
    if (match) return { resultUrl: match[0], status: 'succeeded' };
    return { resultUrl: null, status: 'unknown' };
  },

  /**
   * 登录态判定：头条的登录墙会改地址，所以先看 URL 再兜底看页面上有没有登录入口。
   * 判成"未登录"的代价只是让用户多扫一次码，判成"已登录"的代价是白跑一趟派发。
   */
  async isLoggedIn(page) {
    await this.openHome(page);
    const url = page.url();
    if (/\/auth\/|passport|login/i.test(url)) return false;
    if (/profile_v4|mp\.toutiao\.com\/(home|profile)/.test(url)) return true;
    return !(await page.locator(SELECTORS.loginEntry).first().count().catch(() => 0));
  },
};

async function requireFound(locator, slot) {
  const count = await locator.count().catch(() => 0);
  if (count > 0) return;
  const error = new Error(`今日头条页面缺少预期元素: ${slot}`);
  error.failClass = 'page_changed';
  throw error;
}

export { ENTRY };
