# GEO 自媒体发布执行面：Node + Playwright(Chromium) + CDP 帧中继。
#
# 基础镜像刻意用 Playwright 官方镜像而不是裸 node：它自带 Chromium 运行所需的全部
# 系统库和一份与 playwright 版本配对的浏览器。裸 node 镜像要自己凑 apt 依赖，
# Ubuntu/Debian 各版本的包名（libasound2 vs libasound2t64）不一样，凑错的报错误导性很强。
#
# 版本必须与 package-lock.json 里的 playwright-core 同版本号：镜像自带的 chromium
# revision 要正好是 playwright-core 期望的那个，否则 install:browsers 得在构建期重下。
# 升级依赖后先确认 tag 存在：node -e "fetch('https://mcr.microsoft.com/v2/playwright/tags/list')
#   .then(r=>r.json()).then(j=>console.log(j.tags.filter(t=>t.startsWith('v1.63.0-noble'))))"
ARG PLAYWRIGHT_IMAGE=m.daocloud.io/mcr.microsoft.com/playwright
ARG PLAYWRIGHT_VERSION=v1.63.0-noble

FROM ${PLAYWRIGHT_IMAGE}:${PLAYWRIGHT_VERSION}

LABEL maintainer="SCRM"

# Xvfb：sessions.js 里 headless:false 是刻意的（内容平台对无头浏览器风控更严），
# 所以容器里必须有显示服务。fonts-noto-cjk：缺中文字体时子窗口画面全是豆腐块，
# 而操作员要在这块画面上读平台提示、自己点「发布」。
ARG APT_MIRROR=https://mirrors.aliyun.com/ubuntu

# 主机名要带 `([a-z]+\.)*` 前缀：官方 ubuntu 镜像可能是 archive. / security. / **azure.archive.**
# ubuntu.com，只匹配前两种时这条 sed 会静默不命中 —— 镜像看着换了、apt 还在原站，
# 表现成"构建卡住"而不是报错。所以替换完必须断言真的改干净。
RUN set -eu; \
    for source in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do \
      [ -f "$source" ] || continue; \
      sed -i -E "s#https?://([a-z]+\.)*(archive|security)\.ubuntu\.com/ubuntu#${APT_MIRROR}#g" "$source"; \
    done; \
    if grep -rEq "https?://([a-z]+\.)*(archive|security)\.ubuntu\.com" \
        /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then \
      echo "apt 源替换未生效，仍指向官方站点：" >&2; \
      grep -rE "ubuntu\.com" /etc/apt/sources.list /etc/apt/sources.list.d >&2 || true; \
      exit 1; \
    fi; \
    apt-get update \
    && apt-get install -y --no-install-recommends xvfb fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖先单独一层：改业务代码不触发重新下载 node_modules。
# 走国内源：默认 registry 与 Playwright CDN 在这台机器上都慢到不可用。
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm ci --omit=dev

COPY . .

# 已有镜像里带了浏览器；这一步只在版本不匹配时补下载，幂等。
# 注意：只装 chromium。其余引擎用不上，且子窗口的实时画面依赖 CDP，只能是 Chromium。
RUN PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
    npm run install:browsers

# profile 落盘目录。GEO_BROWSER_DATA_DIR 指向这里，整个目录要挂出来持久化：
# 容器文件系统一旦随发布销毁，全部账号都要重新扫码。
RUN mkdir -p /var/lib/geo-media-browser

ENV TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production \
    GEO_BROWSER_HOST=0.0.0.0 \
    GEO_BROWSER_PORT=3310 \
    GEO_BROWSER_DATA_DIR=/var/lib/geo-media-browser \
    # 容器内以 root 运行，Chromium 沙箱需要 user namespaces 或 CAP_SYS_ADMIN，
    # 这里以容器本身作为隔离边界。换非 root 用户跑时把这个开关恢复成 1。
    GEO_BROWSER_CHROMIUM_SANDBOX=0 \
    DISPLAY=:99

EXPOSE 3310

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.GEO_BROWSER_PORT||3310)+"/v1/contract").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

# 显式用 /bin/sh 调脚本：Windows 侧检出可能丢掉可执行位，写成 shebang 直接执行会在
# 容器启动时才报错，排查成本高。
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD ["node", "src/server.js"]
