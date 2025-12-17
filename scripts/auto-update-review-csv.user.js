// ==UserScript==
// @name         评论提取器 CSV（Amazon兼容版）
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Trustpilot & Amazon 自动抓取，优化选择器生成逻辑，支持手动选取、预览与导出
// @author       Jat
// @match        https://www.trustpilot.com/review/*
// @match        https://www.amazon.com/product-reviews/*
// @grant        GM_download
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/Jat-echo/tampermonkey-review-csv/main/scripts/auto-update-review-csv.user.js
// @downloadURL  https://raw.githubusercontent.com/Jat-echo/tampermonkey-review-csv/main/scripts/auto-update-review-csv.user.js
// ==/UserScript==

(function () {
    'use strict';

    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const textOrEmpty = (el) => (el ? (el.innerText ?? el.textContent ?? '').trim() : '');

    // ========== 星级提取函数 ==========
    function extractRating(el) {
        if (!el) return '';

        // 方法1: 从 i 标签的 class 提取（Amazon: "a-icon-star a-star-5"）
        const classList = el.classList ? Array.from(el.classList) : [];
        const starClass = classList.find(c => /a-star-\d+/.test(c));
        if (starClass) {
            const match = starClass.match(/a-star-(\d+)/);
            if (match) return match[1];
        }

        // 方法2: 从 span.a-icon-alt 提取（Amazon: "5.0 out of 5 stars"）
        const altText = el.querySelector ? el.querySelector('.a-icon-alt') : null;
        if (altText) {
            const text = textOrEmpty(altText);
            const match = text.match(/(\d+(?:\.\d+)?)\s+out\s+of\s+5/i);
            if (match) return match[1];
        }

        // 方法3: 从 img 的 alt 属性提取（Trustpilot: "Rated 1 out of 5 stars"）
        const alt = el.getAttribute ? el.getAttribute('alt') : '';
        const match = alt.match(/Rated\s+(\d+(?:\.\d+)?)\s+out\s+of\s+5/i);
        if (match) return match[1];

        // 方法4: 从父元素的 data-service-review-rating 属性提取
        const parent = el.closest ? el.closest('[data-service-review-rating]') : null;
        if (parent) {
            const rating = parent.getAttribute('data-service-review-rating');
            if (rating) return rating;
        }

        // 方法5: 如果元素本身有 data-service-review-rating 属性
        const directRating = el.getAttribute ? el.getAttribute('data-service-review-rating') : '';
        if (directRating) return directRating;

        // 方法6: 从 src 提取（如 "stars-1.svg" -> "1"）
        const src = el.getAttribute ? el.getAttribute('src') : '';
        const srcMatch = src.match(/stars-(\d+(?:\.\d+)?)\./);
        if (srcMatch) return srcMatch[1];

        // 回退：返回文本内容
        return textOrEmpty(el);
    }

    // ---------- 抓取 ----------
    function extractComments(cfg) {
        const items = Array.from(document.querySelectorAll(cfg.itemSelector));
        const rows = items.map(item => ({
            用户名: textOrEmpty(safeQuery(item, cfg.userRelSelector)),
            评论日期: textOrEmpty(safeQuery(item, cfg.dateRelSelector)),
            评论星级: extractRating(safeQuery(item, cfg.ratingRelSelector)),
            评论标题: textOrEmpty(safeQuery(item, cfg.titleRelSelector)),
            评论内容: textOrEmpty(safeQuery(item, cfg.contentRelSelector)),
        }));
        return { rows, items };
    }

    function pageSignature(cfg) {
        const url = location.pathname + location.search;
        const items = Array.from(document.querySelectorAll(cfg.itemSelector));
        const count = items.length;
        const firstTitle = items[0]
        ? textOrEmpty(items[0].querySelector(cfg.titleRelSelector || 'h2, h5, [data-hook="review-title"]'))
        : '';
        const sig = `${url}|${count}|${firstTitle.slice(0,80)}`;
        return { sig, count };
    }

    async function waitForChange(prevSig, cfg, { timeoutMs = 6000, intervalMs = 300 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await sleep(intervalMs);
            const { sig } = pageSignature(cfg);
            if (sig !== prevSig) return true; // 页面内容发生变化
        }
        return false; // 超时未变化
    }

    function safeQuery(root, sel) {
        if (!sel) return null;
        try {
            return root.querySelector(sel);
        } catch {
            // 如果传入了绝对选择器，退回到全局匹配
            try { return document.querySelector(sel); } catch { return null; }
        }
    }

    // 修改 toCSV 函数，添加 UTF-8 BOM
    function toCSV(rows) {
        const headers = ['用户名', '评论日期', '评论星级', '评论标题', '评论内容'];
        const escape = (v) => `"${(v ?? '').toString().replace(/"/g, '""')}"`;
        const lines = [headers.map(escape).join(',')];
        for (const r of rows) {
            lines.push([
                r.用户名,
                r.评论日期,
                r.评论星级,
                r.评论标题,
                r.评论内容
            ].map(escape).join(','));
        }
        // ✅ 添加 UTF-8 BOM 标记
        return '\uFEFF' + lines.join('\n');
    }

    function showToast(msg) {
        let t = document.getElementById('tm-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'tm-toast';
            Object.assign(t.style, {
                position: 'fixed', top: '12px', right: '12px', zIndex: 2147483647,
                background: '#323232', color: '#fff', padding: '8px 12px',
                borderRadius: '6px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontSize: '12px'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        setTimeout(() => { t.style.opacity = '0'; }, 2200);
    }

    function rowKeyOf(item) {
        // 优先使用稳定 data- 属性（若存在）
        const idAttr = item.getAttribute('data-review-id') || 
              item.getAttribute('data-service-review-card-paper-id') ||
              item.getAttribute('id');
        if (idAttr) return `id:${idAttr}`;

        // 回退：基于标题+内容的哈希（避免重复）
        const title = textOrEmpty(item.querySelector('h2, h5, [data-hook="review-title"]'));
        const content = textOrEmpty(item.querySelector('p, [data-hook="review-body"]'));
        const hash = `${title}||${content}`.toLowerCase();
        return `tc:${hash}`;
    }

    function appendToCacheDedup(rows, items) {
        const cache = JSON.parse(localStorage.getItem("tp_comments") || "[]");
        const seen = new Set(cache.map(r => r.__k));

        items.forEach((item, idx) => {
            const k = rowKeyOf(item);
            if (!seen.has(k)) {
                seen.add(k);
                cache.push({ ...rows[idx], __k: k });
            }
        });

        localStorage.setItem("tp_comments", JSON.stringify(cache));
    }

    // 清空缓存
    function clearCache() {
        localStorage.removeItem("tp_comments");
    }

    // 导出缓存
    function exportCacheWithProgress(progressBox, page, total) {
        if (progressBox) progressBox.innerHTML = `✅ 抓取完成，共 ${page} 页，${total} 条评论`;

        const rows = JSON.parse(localStorage.getItem("tp_comments") || "[]").map(({__k, ...r}) => r);
        const csv = toCSV(rows);

        try {
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);

            GM_download({
                url: url,
                name: `comments_${Date.now()}.csv`,
                onload: () => URL.revokeObjectURL(url), // 下载完成后释放
            });
        } catch {
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `comments_${Date.now()}.csv`;
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(a.href);
            a.remove();
        }
        showToast(`已导出，共 ${page} 页，${total} 条评论`);
    }

    function randomWait(minMs, maxMs) {
        const range = Math.max(0, maxMs - minMs);
        return minMs + Math.floor(Math.random() * (range + 1));
    }

    async function run(cfg, onlyCurrentPage = false) {
        clearCache();
        const progressBox = document.getElementById('progressBox');

        const scrapeAndAppend = () => {
            const { rows, items } = extractComments(cfg);
            appendToCacheDedup(rows, items);
            return rows.length;
        };

        let total = 0;
        let page = 1; // 首页计为第 1 页

        total += scrapeAndAppend();
        if (progressBox) progressBox.innerHTML = `当前第 ${page} 页，累计 ${total} 条评论`;

        if (onlyCurrentPage) {
            exportCacheWithProgress(progressBox, page, total);
            return;
        }

        // 继续翻页，最多到 cfg.maxPages
        // 目标是总页数不超过 cfg.maxPages（含首页）
        while (page < cfg.maxPages) {
            const nextBtn = cfg.nextSelector ? document.querySelector(cfg.nextSelector) : null;
            if (!nextBtn) break;

            const disabled = nextBtn.getAttribute('aria-disabled') === 'true' || nextBtn.tabIndex === -1;
            if (disabled) break;

            // 翻页前签名
            const { sig: prevSig } = pageSignature(cfg);

            // 点击下一页
            nextBtn.click();

            // 随机等待：min = waitMs, max = 2*waitMs
            const delay = randomWait(cfg.waitMs, cfg.waitMs * 2);
            if (progressBox) progressBox.innerHTML = `当前第 ${page} 页，累计 ${total} 条评论<br>等待 ${delay} 毫秒后继续...`;
            await sleep(delay);

            // 等待内容变更
            const changed = await waitForChange(prevSig, cfg, { timeoutMs: 8000, intervalMs: 300 });
            if (!changed) {
                // 没变更就不递增页码，更不再点击
                if (progressBox) progressBox.innerHTML = `未检测到页面变化，停止在第 ${page} 页，累计 ${total} 条`;
                break;
            }

            // 到这里才视为真正进入下一页 → 递增页码
            page++;

            // 抓取并追加
            const added = scrapeAndAppend();
            total += added;
            if (progressBox) progressBox.textContent = `当前第 ${page} 页，累计 ${total} 条评论`;

            // 如果这一页没有新增，直接结束（避免空页导致错计）
            if (added === 0) break;
        }

        exportCacheWithProgress(progressBox, page, total);
    }

    // ---------- 网站检测 ----------
    const isTP = () => location.hostname.includes('trustpilot.com');
    const isAmazon = () => location.hostname.includes('amazon.com');

    // ---------- 配置 ----------
    function getCfg() {
        const ui = {
            item: document.getElementById('itemSel'),
            user: document.getElementById('userRel'),
            date: document.getElementById('dateRel'),
            rating: document.getElementById('ratingRel'),
            title: document.getElementById('titleRel'),
            content: document.getElementById('contentRel'),
            next: document.getElementById('nextSel'),
            maxPages: document.getElementById('maxPages'),
            waitMs: document.getElementById('waitMs'),
        };

        const manual = {
            itemSelector: ui.item?.value.trim(),
            userRelSelector: ui.user?.value.trim(),
            dateRelSelector: ui.date?.value.trim(),
            ratingRelSelector: ui.rating?.value.trim(),
            titleRelSelector: ui.title?.value.trim(),
            contentRelSelector: ui.content?.value.trim(),
            nextSelector: ui.next?.value.trim(),
            maxPages: Number(ui.maxPages?.value) || 20,
            waitMs: Number(ui.waitMs?.value) || 1000,
        };

        if (isTP()) {
            return {
                itemSelector: manual.itemSelector || 'section[data-nosnippet="false"] article[data-service-review-card-paper="true"]',
                userRelSelector: manual.userRelSelector || 'span[data-consumer-name-typography]',
                dateRelSelector: manual.dateRelSelector || '[data-testid="review-badge-date"] span',
                ratingRelSelector: manual.ratingRelSelector || 'div[data-service-review-rating] img',
                titleRelSelector: manual.titleRelSelector || 'h2[data-service-review-title-typography]',
                contentRelSelector: manual.contentRelSelector || 'p[data-service-review-text-typography]',
                nextSelector: manual.nextSelector || 'a[data-pagination-button-next-link="true"], a[data-pagination-button-next]',
                maxPages: manual.maxPages,
                waitMs: manual.waitMs,
            };
        }

        if (isAmazon()) {
            return {
                itemSelector: manual.itemSelector || 'li[data-hook="review"]',
                userRelSelector: manual.userRelSelector || '.a-profile-name',
                dateRelSelector: manual.dateRelSelector || '[data-hook="review-date"]',
                ratingRelSelector: manual.ratingRelSelector || '[data-hook="review-star-rating"]',
                titleRelSelector: manual.titleRelSelector || '[data-hook="review-title"] > span:last-of-type',
                contentRelSelector: manual.contentRelSelector || '[data-hook="review-body"] > span',
                nextSelector: manual.nextSelector || '.a-last a',
                maxPages: manual.maxPages,
                waitMs: manual.waitMs,
            };
        }

        return manual;
    }

    // ---------- 选取工具 ----------
    function enablePickMode({ targetInputId, relativeToArticle = false, statusEl }) {
        const panel = document.getElementById('tm-comment-exporter-panel');
        const targetInput = document.getElementById(targetInputId);
        if (!targetInput) return;

        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'absolute',
            border: '2px dashed #e53935',
            background: 'rgba(227,59,46,0.07)',
            pointerEvents: 'none',
            zIndex: 2147483647,
            boxSizing: 'border-box',
        });
        document.documentElement.appendChild(overlay);

        const hint = statusEl || document.getElementById('pickStatus');
        if (hint) {
            hint.textContent = `选取模式：请点击页面元素以填充「${labelById(targetInputId)}」，按 Esc 取消`;
            hint.style.color = '#e53935';
            hint.style.fontWeight = '600';
        }

        const moveHandler = (e) => {
            if (panel && panel.contains(e.target)) return; // 忽略面板内移动
            const rect = e.target.getBoundingClientRect();
            overlay.style.top = rect.top + window.scrollY + 'px';
            overlay.style.left = rect.left + window.scrollX + 'px';
            overlay.style.width = rect.width + 'px';
            overlay.style.height = rect.height + 'px';
        };

        const clickHandler = (e) => {
            if (panel && panel.contains(e.target)) return; // 忽略面板点击
            e.preventDefault();
            e.stopPropagation();

            if (relativeToArticle) {
                const article = closestReviewArticle(e.target);
                if (article) {
                    const rel = buildRelativeSelector(e.target, article);
                    targetInput.value = rel || fallbackSelector(e.target);
                } else {
                    // 找不到评论 article，就用稳健选择器作为绝对
                    targetInput.value = fallbackSelector(e.target);
                }
            } else {
                targetInput.value = fallbackSelector(e.target);
            }
            cleanup();
        };

        const keyHandler = (e) => {
            if (e.key === 'Escape') cleanup();
        };

        function cleanup() {
            document.removeEventListener('mousemove', moveHandler, true);
            document.removeEventListener('click', clickHandler, true);
            document.removeEventListener('keydown', keyHandler, true);
            overlay.remove();
            if (hint) {
                hint.textContent = '选取模式已退出';
                hint.style.color = '#888';
                setTimeout(() => {
                    hint.textContent = '';
                }, 1200);
            }
        }

        document.addEventListener('mousemove', moveHandler, true);
        document.addEventListener('click', clickHandler, true);
        document.addEventListener('keydown', keyHandler, true);
    }

    function labelById(id) {
        const map = {
            itemSel: '评论容器',
            userRel: '用户名',
            dateRel: '日期',
            ratingRel: '星级',
            titleRel: '标题',
            contentRel: '内容',
            nextSel: '下一页按钮',
        };
        return map[id] || id;
    }

    function closestReviewArticle(el) {
        // Trustpilot
        const tpArticle = el.closest('article[data-service-review-card-paper="true"]');
        if (tpArticle) return tpArticle;

        // Amazon
        const amznReview = el.closest('li[data-hook="review"]');
        if (amznReview) return amznReview;

        return null;
    }

    // ========== 优化的选择器生成逻辑 ==========
    function fallbackSelector(el) {
        if (!el) return '';

        // 优先使用稳定的 data-hook 属性（Amazon常用）
        const dataHook = el.getAttribute('data-hook');
        if (dataHook) {
            const sel = `[data-hook="${cssEscape(dataHook)}"]`;
            if (isUnique(sel)) return sel;
        }

        // 其次使用 ID
        if (el.id && isUnique(`#${cssEscape(el.id)}`)) {
            return `#${cssEscape(el.id)}`;
        }

        // 使用其他 data-* 属性
        const dataSel = dataAttrSelector(el);
        if (dataSel && isUnique(dataSel)) return dataSel;

        // 使用类名（排除随机类）
        const clsSel = classSelector(el);
        if (clsSel && isUnique(clsSel)) return clsSel;

        // 最后才使用路径
        return uniquePath(el);
    }

    function dataAttrSelector(el) {
        const attrs = Array.from(el.attributes || []);

        // 优先级：data-hook > data-testid > 其他 data-*
        const priorityAttrs = ['data-hook', 'data-testid'];
        for (const attrName of priorityAttrs) {
            const attr = attrs.find(a => a.name === attrName);
            if (attr) {
                return `[${attr.name}="${cssEscape(attr.value)}"]`;
            }
        }

        // 其他 data-* 属性
        const dataAttr = attrs.find(a => a.name.startsWith('data-'));
        if (dataAttr) {
            return `${el.tagName.toLowerCase()}[${dataAttr.name}="${cssEscape(dataAttr.value)}"]`;
        }

        // 稳定属性
        const stable = attrs.find(a =>
                                  ['aria-label', 'role', 'itemprop', 'name', 'type'].includes(a.name)
                                 );
        if (stable) {
            return `${el.tagName.toLowerCase()}[${stable.name}="${cssEscape(stable.value)}"]`;
        }

        return '';
    }

    function classSelector(el) {
        const tag = el.tagName.toLowerCase();
        const classes = (el.className || "").toString().trim().split(/\s+/).filter(Boolean);

        // 排除随机类和无意义类
        const filtered = classes.filter(c => 
                                        !/styles_/.test(c) &&
                                        !/__\w{4,}/.test(c) &&
                                        !/^[a-z]-[a-z0-9-]+$/.test(c) // 排除 Amazon 的 a-xxxx 类
                                       );

        if (filtered.length) {
            const trySel = `${tag}.${filtered.slice(0, 2).map(cssEscape).join('.')}`;
            return trySel;
        }
        return '';
    }

    function uniquePath(el) {
        const parts = [];
        let cur = el;
        let depth = 0;

        while (cur && depth < 5 && cur.nodeType === 1 && cur.tagName) {
            const tag = cur.tagName.toLowerCase();
            const parent = cur.parentElement;

            if (!parent) {
                parts.unshift(tag);
                break;
            }

            // 避免使用 nth-of-type，改用更通用的标签
            const piece = nodePiece(cur);
            parts.unshift(piece);

            const sel = parts.join(' > ');
            if (isUnique(sel)) return sel;

            cur = parent;
            depth++;
        }

        return parts.join(' > ') || el.tagName.toLowerCase();
    }

    function isUnique(sel) {
        try {
            const n = document.querySelectorAll(sel).length;
            return n === 1;
        } catch {
            return false;
        }
    }

    function cssEscape(s) {
        return (s || '').replace(/"/g, '\\"');
    }

    // ========== 优化的相对选择器生成 ==========
    function buildRelativeSelector(target, ancestor) {
        if (!target || !ancestor) return '';
        if (target === ancestor) return '';

        // 优先尝试使用 data-hook（Amazon常用）
        const dataHook = target.getAttribute('data-hook');
        if (dataHook) {
            const sel = `[data-hook="${cssEscape(dataHook)}"]`;
            const found = ancestor.querySelector(sel);
            if (found === target) return sel;
        }

        // 尝试简单的类或属性选择器
        const simpleSel = simpleRelativeSelector(target);
        if (simpleSel) {
            const found = ancestor.querySelector(simpleSel);
            if (found === target) return simpleSel;
        }

        // 回退到路径方式（但避免过度使用 nth-of-type）
        const path = [];
        let cur = target;
        let safety = 0;

        while (cur && cur !== ancestor && safety++ < 8) {
            const piece = nodePiece(cur);
            path.unshift(piece);

            // 每次都测试是否已经唯一
            const testSel = path.join(' > ');
            try {
                const matches = ancestor.querySelectorAll(testSel);
                if (matches.length === 1 && matches[0] === target) {
                    return testSel;
                }
            } catch {}

            cur = cur.parentElement;
        }

        return path.join(' > ');
    }

    function simpleRelativeSelector(el) {
        const tag = el.tagName.toLowerCase();

        // 优先 data-hook
        const dataHook = el.getAttribute('data-hook');
        if (dataHook) return `[data-hook="${cssEscape(dataHook)}"]`;

        // 其次 data-* 属性
        const attrs = Array.from(el.attributes || []);
        const dataAttr = attrs.find(a => a.name.startsWith('data-'));
        if (dataAttr) {
            return `${tag}[${dataAttr.name}="${cssEscape(dataAttr.value)}"]`;
        }

        // 有意义的类名
        const classes = (el.className || "").toString().trim().split(/\s+/).filter(Boolean);
        const filtered = classes.filter(c => 
                                        !/styles_/.test(c) &&
                                        !/__\w{4,}/.test(c) &&
                                        c.length > 2 &&
                                        !/^[a-z]-[a-z0-9-]+$/.test(c)
                                       );

        if (filtered.length) {
            return `${tag}.${filtered[0]}`;
        }

        return '';
    }

    function nodePiece(el) {
        const tag = el.tagName.toLowerCase();

        // 优先 data-hook
        const dataHook = el.getAttribute('data-hook');
        if (dataHook) return `[data-hook="${cssEscape(dataHook)}"]`;

        // 其次 data-* 属性
        const dataSel = dataAttrSelector(el);
        if (dataSel) return dataSel;

        // 有意义的类
        const clsSel = classSelector(el);
        if (clsSel) return clsSel;

        // 只在万不得已时使用 nth-of-type
        const parent = el.parentElement;
        if (!parent) return tag;

        const siblings = Array.from(parent.children).filter(ch => ch.tagName.toLowerCase() === tag);
        if (siblings.length === 1) return tag; // 如果是唯一的该类型标签，就不需要 nth

        const idx = siblings.indexOf(el) + 1;
        return `${tag}:nth-of-type(${idx})`;
    }

    // ---------- 美化面板 ----------
    function createPanel() {
        if (document.getElementById('tm-comment-exporter-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'tm-comment-exporter-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: 2147483647,
            background: '#f9f9fb',
            border: '1px solid #ddd',
            padding: '16px',
            fontSize: '13px',
            width: '400px',
            maxHeight: '90vh',
            overflowY: 'auto',
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            borderRadius: '10px',
            fontFamily: 'Segoe UI, Arial, sans-serif',
            lineHeight: '1.5',
        });

        let autoTag = '<span style="color:#888;">手动模式：请填写选择器或使用选取按钮</span>';
        if (isTP()) {
            autoTag = '<span style="color:#04da8d;font-weight:600;">Trustpilot 自动选择器已预填</span>';
        } else if (isAmazon()) {
            autoTag = '<span style="color:#ff9800;font-weight:600;">Amazon 自动选择器已预填</span>';
        }

        const inputStyle = "flex:1;padding:6px;border:1px solid #ccc;border-radius:4px;";
        const miniBtnStyle = "padding:4px 10px;background:#eee;border:1px solid #ccc;border-radius:4px;cursor:pointer;";
        const btnStyle = (color) => `width:100%;margin-top:8px;background:${color};color:#fff;border:none;padding:10px;border-radius:6px;cursor:pointer;font-weight:600;`;

        function makeField(label,id,btnId,placeholder){
            return `
        <div style="margin-bottom:10px;">
          <label style="display:flex;align-items:center;gap:8px;">
            <span style="flex:0 0 120px;color:#333;font-weight:500;">${label}</span>
            <input id="${id}" placeholder="${placeholder}" style="${inputStyle}">
            <button id="${btnId}" style="${miniBtnStyle}">选取</button>
          </label>
        </div>`;
        }

        panel.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:12px;border-left:4px solid #2196F3;padding-left:8px;">
        评论提取器 CSV
      </div>
      <div style="margin-bottom:6px;">${autoTag}</div>
      <div id="pickStatus" style="min-height:18px;margin-bottom:8px;color:#888;"></div>

      <fieldset style="border:none;margin:0;padding:0 0 12px 0;">
        <legend style="font-weight:600;color:#444;margin-bottom:8px;">选择器设置</legend>
        ${makeField("评论容器","itemSel","pickItem","li[data-hook='review']")}
        ${makeField("用户名","userRel","pickUser",".a-profile-name")}
        ${makeField("日期","dateRel","pickDate","[data-hook='review-date']")}
        ${makeField("星级","ratingRel","pickRating","[data-hook='review-star-rating']")}
        ${makeField("标题","titleRel","pickTitle","[data-hook='review-title'] > span:last-of-type")}
        ${makeField("内容","contentRel","pickContent","[data-hook='review-body'] > span")}
        ${makeField("下一页按钮","nextSel","pickNext",".a-last a")}
      </fieldset>

      <fieldset style="border:none;margin:0;padding:0 0 12px 0;">
        <legend style="font-weight:600;color:#444;margin-bottom:8px;">翻页设置</legend>
        <div style="display:flex;gap:12px;">
          <input id="maxPages" type="number" value="20" placeholder="最大翻页" style="${inputStyle}">
          <input id="waitMs" type="number" value="1000" placeholder="等待毫秒" style="${inputStyle}">
        </div>
      </fieldset>

      <div style="margin-top:12px;">
        <button id="previewBtn" style="${btnStyle('#2196F3')}">🔍 预览前几条</button>
        <button id="startAll"   style="${btnStyle('#4CAF50')}">📥 导出全部 CSV</button>
        <button id="startCur"   style="${btnStyle('#FF9800')}">📄 只导出当前页</button>
      </div>

      <div id="progressBox" style="margin-top:10px;font-size:12px;color:#333;"></div>

      <div id="previewBox" style="margin-top:12px;font-size:12px;color:#333;max-height:220px;overflow:auto;
        border:1px solid #ddd;padding:8px;border-radius:6px;background:#fff;"></div>
    `;

        document.body.appendChild(panel);

        // 自动预填选择器
        if (isTP()) {
            document.getElementById('itemSel').value = "section[data-nosnippet='false'] article[data-service-review-card-paper='true']";
            document.getElementById('userRel').value = "span[data-consumer-name-typography]";
            document.getElementById('dateRel').value = "[data-testid='review-badge-date'] span";
            document.getElementById('ratingRel').value = "div[data-service-review-rating] img";
            document.getElementById('titleRel').value = "h2[data-service-review-title-typography]";
            document.getElementById('contentRel').value = "p[data-service-review-text-typography]";
            document.getElementById('nextSel').value = "a[data-pagination-button-next-link='true'], a[data-pagination-button-next]";
        } else if (isAmazon()) {
            document.getElementById('itemSel').value = "li[data-hook='review']";
            document.getElementById('userRel').value = ".a-profile-name";
            document.getElementById('dateRel').value = "[data-hook='review-date']";
            document.getElementById('ratingRel').value = "[data-hook='review-star-rating']";
            document.getElementById('titleRel').value = "[data-hook='review-title'] > span:last-of-type";
            document.getElementById('contentRel').value = "[data-hook='review-body'] > span";
            document.getElementById('nextSel').value = ".a-last a";
        }

        // 预览与导出
        document.getElementById('previewBtn').onclick = () => {
            const cfg = getCfg();
            const { rows } = extractComments(cfg);
            const box = document.getElementById('previewBox');
            if (!rows.length) {
                box.innerHTML = '<i>未采集到评论，请检查容器和相对选择器。</i>';
                return;
            }

            const renderStars = (rating) => {
                if (!rating) return '<span style="color:#ccc;">-</span>';
                const num = parseFloat(rating);
                if (isNaN(num)) return `<span style="color:#888;">${rating}</span>`;

                const fullStars = Math.floor(num);
                const hasHalf = (num % 1) >= 0.5;
                const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0);

                let stars = '<span style="color:#ff9800;font-size:14px;">';
                stars += '★'.repeat(fullStars);
                if (hasHalf) stars += '½';
                stars += '</span>';
                stars += '<span style="color:#ddd;font-size:14px;">';
                stars += '★'.repeat(emptyStars);
                stars += '</span>';
                stars += ` <span style="color:#666;font-size:12px;">(${rating})</span>`;

                return stars;
            };

            box.innerHTML = rows.slice(0, 5).map(r =>
                                                 `<div style="margin-bottom:8px;">
                 <b>${r.用户名 || '(无名)'}</b> (${r.评论日期 || '-'})
                 ${renderStars(r.评论星级)}<br>
                 <i>${r.评论标题 || '-'}</i><br>
                 ${r.评论内容 || '-'}
               </div><hr>`
            ).join('');
        };

        document.getElementById('startAll').onclick = () => run(getCfg(), false);
        document.getElementById('startCur').onclick = () => run(getCfg(), true);

        // 选取按钮绑定
        const statusEl = document.getElementById('pickStatus');
        document.getElementById('pickItem').onclick = () =>
        enablePickMode({ targetInputId: 'itemSel', relativeToArticle: false, statusEl });

        document.getElementById('pickUser').onclick = () =>
        enablePickMode({ targetInputId: 'userRel', relativeToArticle: true, statusEl });

        document.getElementById('pickDate').onclick = () =>
        enablePickMode({ targetInputId: 'dateRel', relativeToArticle: true, statusEl });

        document.getElementById('pickRating').onclick = () =>
        enablePickMode({ targetInputId: 'ratingRel', relativeToArticle: true, statusEl });

        document.getElementById('pickTitle').onclick = () =>
        enablePickMode({ targetInputId: 'titleRel', relativeToArticle: true, statusEl });

        document.getElementById('pickContent').onclick = () =>
        enablePickMode({ targetInputId: 'contentRel', relativeToArticle: true, statusEl });

        document.getElementById('pickNext').onclick = () =>
        enablePickMode({ targetInputId: 'nextSel', relativeToArticle: false, statusEl });
    }

    // ---------- 稳健注入 ----------
    function init() {
        createPanel();
        document.addEventListener('DOMContentLoaded', createPanel);
        setTimeout(createPanel, 1000);
    }

    init();
})();
