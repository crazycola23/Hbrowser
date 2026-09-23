/**
 * 抖音（创作者中心 · 图文）适配器。
 *
 * 形态与另外两个平台不同，两处要单独说清：
 *   1. 抖音没有"标题 + 长正文"的传统文章位（一期接的是**图文**：若干张图 + 一段标题式文案
 *      + 长描述）。所以 supportsLongBody=false，正文按描述填，GEO 侧不因此少发一张图。
 *   2. 图文必须有图。一张图都没拿到时**不能当无图发布**，要显式失败（见 fillArticle）。
 *
 * ⚠ 入口里查证过的只有创作者中心首页与内容上传页
 * （`https://creator.douyin.com/` 与 `https://creator.douyin.com/creator-micro/content/upload`）。
 * 图文 tab、输入框与发布按钮的选择器、以及笔记详情页 URL 形态**全部未实测**（前置 P-2）。
 * 取不到一律判 `page_changed` 停住，不猜第二个候选。
 */
const ENTRY = {
  home: 'https://creator.douyin.com/',
  // 抖音创作者中心的登录是扫码/验证码墙，未登录访问后台会被导到登录态入口页。
  login: 'https://creator.douyin.com/',
  // 内容上传页（图文 tab 在这里面）。tab 定位方式未实测。
  publish: 'https://creator.douyin.com/creator-micro/content/upload',
};

const SELECTORS = {
  // 图文的"标题"是一个单行输入，长文案是另一个可编辑区（未实测）。
  bodyEditor: '[contenteditable="true"], .ql-editor, textarea',
  imageUpload: 'input[type=file]',
  loginEntry: 'text=登录',
  publishButton: 'text=发布',
  qrCode: 'canvas, img[alt*="二维码"], .login-code',
  titleInput: 'input[placeholder*="标题"]',
};

export const douyinAdapter = {
  code: 'douyin',
  implemented: true,
  modes: ['manual_confirm'],
  selectors: SELECTORS,
  supportsImageUpload: true,
  // 一期不做长文：抖音图文的正文是描述，不是排版容器。业务侧只经 capabilities 读这个布尔，
  // 不允许按平台码硬分支（需求 §十）。
  supportsLongBody: false,

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
   * 填一条图文，填完就停（需求 §六、N-10：AI 产出永不触发发布）。
   *
   * 图必须先落地：抖音没有无图图文位，跳过去等于把一条发不出去的东西排队成"等待人工确认"。
   */
  async fillArticle(page, { images = [], title, contentHtml }) {
    if (images.length === 0) {
      const error = new Error('抖音图文必须至少配一张图，本次未上传任何配图');
      error.failClass = 'upload_failed';
      throw error;
    }

    const filled = { cover: false, images: 0, text: false, title: false };

    const upload = page.locator(SELECTORS.imageUpload).first();
    await requireFound(upload, 'image_upload');
    await upload.setInputFiles(images.map((image) => image.tempPath));
    filled.cover = true;
    filled.images = images.length;

    const titleLocator = page.locator(SELECTORS.titleInput).first();
    await requireFound(titleLocator, 'title_input');
    await titleLocator.click();
    await titleLocator.fill(title);
    filled.title = true;

    const body = page.locator(SELECTORS.bodyEditor).first();
    await requireFound(body, 'body_editor');
    await body.click();
    // 注入点在**已登录的平台页面**内，是本项目最坏的 XSS 落点：解析后删危险节点、
    // 剥 on* 与 javascript:，再把结果塞进去。整段必须在 evaluate 里自包含。
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
      // 描述不是富文本容器时用纯文本兜底，宁可掉格式也不注入未渲染的 HTML 源码。
      if (element.isContentEditable) {
        element.innerHTML = root.innerHTML;
      } else {
        element.textContent = root.textContent ?? '';
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, contentHtml);
    filled.text = true;

    return filled;
  },

  /** 只认笔记详情页 URL（`www.douyin.com/note/<id>`）；拿不到一律 unknown。 */
  async inspectResult(page) {
    const match = /https:\/\/www\.douyin\.com\/(?:note|video)\/\d+/.exec(page.url());
    if (match) return { resultUrl: match[0], status: 'succeeded' };
    return { resultUrl: null, status: 'unknown' };
  },

  /**
   * 登录态判定偏保守：判错成"未登录"只是多扫一次码，判错成"已登录"会白跑一趟派发。
   * 抖音的登录墙常见形态是页面内弹二维码而不改地址，所以二维码存在即算未登录。
   */
  async isLoggedIn(page) {
    await this.openHome(page);
    const url = page.url();
    if (/login|passport|sso|account\./i.test(url)) return false;
    if (await page.locator(SELECTORS.qrCode).first().count().catch(() => 0)) return false;
    return !(await page.locator(SELECTORS.loginEntry).first().count().catch(() => 0));
  },
};

async function requireFound(locator, slot) {
  const count = await locator.count().catch(() => 0);
  if (count > 0) return;
  const error = new Error(`抖音页面缺少预期元素: ${slot}`);
  error.failClass = 'page_changed';
  throw error;
}

export { ENTRY };
