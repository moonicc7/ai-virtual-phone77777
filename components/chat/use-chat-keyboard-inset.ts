"use client";

import { useEffect, type RefObject } from "react";

/**
 * 键盘遮挡补偿（仅聊天输入栏）。
 *
 * 背景：部分安卓浏览器（如 Firefox for Android）在软键盘弹出时不会把输入栏
 * 让进可视区，而聊天输入栏是钉在手机壳底部的绝对定位元素，于是被键盘盖住，
 * 用户看不见自己打的字。Chromium 系（Chrome / Edge / 夸克）会自行处理，
 * 不需要也不允许我们再抬一次——否则输入栏被抬两次会飞出屏幕。
 *
 * 判定原则：量「输入栏底边超出可视区底边的距离」。
 *   - 浏览器已经处理好 → 超出量 ≈ 0 → 不补偿（其余浏览器行为完全不变）；
 *   - 浏览器没处理 → 超出量 = 被盖住的真实高度 → 抬这么多。
 * 这样在任何浏览器上都遵循「已经可见就不动」，天然不会误伤。
 *
 * 关键坑（第一版踩过）：不同浏览器缩的是不同的视口——
 *   有的缩 visualViewport.height，有的缩 window.innerHeight，有的两个都缩。
 * 只取其中一个当「可见底边」会算出 0 遮挡而永远不补偿。因此取两者较小值。
 */

/** 小于该值视为噪声（地址栏伸缩、圆角溢出等），不做补偿。 */
const MIN_OCCLUSION_PX = 12;
/** 输入栏标识：优先用 data-ui，兜底用类名（防止属性被改后彻底失效）。 */
const INPUT_BAR_SELECTOR = '[data-ui="input"], .chat-input-bar';

/** 输入栏标识判定。 */
function isInputBar(el: HTMLElement): boolean {
    return el.dataset.ui === "input" || el.classList.contains("chat-input-bar");
}

/**
 * 找出真正可见的那个输入栏。
 * 聊天室可能同时存在多个候选（旧实例未卸载、多选模式的替身等），
 * 只取第一个会挑中尺寸为 0 的隐藏元素，因此扫全部候选、取面积最大的。
 */
function findInputBar(wrapper: HTMLElement): { el: HTMLElement | null; count: number } {
    const candidates: HTMLElement[] = [];
    for (const child of Array.from(wrapper.children)) {
        if (child instanceof HTMLElement && isInputBar(child)) candidates.push(child);
    }
    if (candidates.length === 0) {
        for (const found of Array.from(wrapper.querySelectorAll<HTMLElement>(INPUT_BAR_SELECTOR))) {
            candidates.push(found);
        }
    }

    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
            bestArea = area;
            best = candidate;
        }
    }
    return { el: best, count: candidates.length };
}

/** 可视区底边：取 window.innerHeight 与 visualViewport 底边的较小值。 */
function getVisibleBottom(viewport: VisualViewport | null): number {
    const layoutBottom = window.innerHeight || Number.POSITIVE_INFINITY;
    if (!viewport) return layoutBottom;
    const visualBottom = viewport.offsetTop + viewport.height;
    return Math.min(layoutBottom, visualBottom);
}

// ── 临时诊断角标（验证通过后整块删除，含下面两处调用）──────────────
// 手机上看不到控制台，把关键数值直接画在屏幕上，便于定位是哪一环断了。
const DEBUG_BADGE_ID = "__kb_inset_badge";
function debugBadge(text: string) {
    let el = document.getElementById(DEBUG_BADGE_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = DEBUG_BADGE_ID;
        // 放顶部：键盘弹起会盖住屏幕下半部分，放底部就看不到读数了。
        el.style.cssText = [
            "position:fixed", "left:8px", "top:8px", "z-index:2147483647",
            "max-width:80vw", "padding:4px 8px", "border-radius:6px",
            "background:rgba(0,0,0,.88)", "color:#0f0", "font:11px/1.5 monospace",
            "white-space:pre-wrap", "pointer-events:none", "word-break:break-all",
        ].join(";");
        document.body.appendChild(el);
    }
    el.textContent = text;
}
// ──────────────────────────────────────────────────────────────

export function useChatKeyboardInset<TWrapper extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    refreshKey: string,
) {
    useEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        const viewport = window.visualViewport;

        let applied = 0;
        let frame = 0;
        let savedTransform: string | null = null;
        let savedPriority = "";
        let peakApplied = 0;
        let lastLogged = "";
        const timers: number[] = [];

        // 诊断用峰值：键盘弹起时若角标被遮挡/读数被覆盖，仍能看到当时的极值。
        let peakOccluded = 0;
        let minInnerH = Number.POSITIVE_INFINITY;
        let minVvH = Number.POSITIVE_INFINITY;
        // 虚拟键盘 API（Chrome 系支持，可拿到精确键盘高度）
        const vk = (navigator as Navigator & {
            virtualKeyboard?: {
                boundingRect: DOMRect;
                overlaysContent: boolean;
                addEventListener: (t: string, f: () => void) => void;
            };
        }).virtualKeyboard;

        const vkInfo = () => {
            if (!vk) return "无VK";
            const h = Math.round(vk.boundingRect?.height || 0);
            return `VK ${h} ov${vk.overlaysContent ? 1 : 0}`;
        };

        const reset = (el: HTMLElement) => {
            if (applied === 0 && savedTransform === null) return;
            if (savedTransform === null) {
                el.style.removeProperty("transform");
            } else {
                el.style.setProperty("transform", savedTransform, savedPriority || "");
            }
            delete el.dataset.keyboardInset;
            savedTransform = null;
            savedPriority = "";
            applied = 0;
        };

        const measure = () => {
            frame = 0;
            const found = findInputBar(wrapper);
            const el = found.el;
            if (!el) {
                // 多选模式下输入栏会卸载：清掉簿记，避免残留的 transform
                // 被下次挂载的新元素继承。
                applied = 0;
                savedTransform = null;
                const key = `no-el-${found.count}`;
                if (lastLogged !== key) {
                    lastLogged = key;
                    debugBadge(`未找到输入栏\n候选 ${found.count}`);
                }
                return;
            }

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                reset(el);
                const key = `zero-${found.count}-${Math.round(rect.width)}x${Math.round(rect.height)}`;
                if (lastLogged !== key) {
                    lastLogged = key;
                    debugBadge([
                        `尺寸为0 (候选${found.count})`,
                        `w${Math.round(rect.width)} h${Math.round(rect.height)}`,
                        `offsetW ${el.offsetWidth}`,
                        `wrapH ${Math.round(wrapper.getBoundingClientRect().height)}`,
                    ].join("\n"));
                }
                return;
            }

            // 实测缩放比：布局宽度 offsetWidth → 屏幕宽度 rect.width。
            // 手机壳在窄视口下是整体 CSS 缩放显示的，translateY 作用在缩放之前，
            // 必须先换算，否则抬不到位或抬过头。
            const layoutWidth = el.offsetWidth || 0;
            const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
            const safeScale = scale > 0.1 ? scale : 1;

            // rect 里含上一轮已施加的位移，先加回去还原成「未抬升时」的底边，
            // 否则会形成反馈环：抬起→看似不遮挡→还原→又遮挡→再抬，输入框抖动。
            const appliedScreen = applied * safeScale;
            const visibleBottom = getVisibleBottom(viewport);
            const occluded = Math.round(rect.bottom + appliedScreen - visibleBottom);

            // 峰值记录：只增不减，键盘收起后仍能读到弹起时的极值。
            if (occluded > peakOccluded) peakOccluded = occluded;
            if (window.innerHeight < minInnerH) minInnerH = window.innerHeight;
            if (viewport && viewport.height < minVvH) minVvH = viewport.height;

            // 诊断：值变化时才打日志/刷角标，平时不刷屏。
            const signature = `${occluded}|${Math.round(visibleBottom)}|${safeScale.toFixed(2)}`;
            if (signature !== lastLogged) {
                lastLogged = signature;
                console.log("[keyboard-inset]", {
                    occluded,
                    visibleBottom: Math.round(visibleBottom),
                    innerHeight: window.innerHeight,
                    vvHeight: viewport ? Math.round(viewport.height) : null,
                    vvOffsetTop: viewport ? Math.round(viewport.offsetTop) : null,
                    scale: Number(safeScale.toFixed(2)),
                    applied,
                    peakOccluded,
                    minInnerH: minInnerH === Number.POSITIVE_INFINITY ? null : minInnerH,
                    minVvH: minVvH === Number.POSITIVE_INFINITY ? null : minVvH,
                });
                debugBadge([
                    `遮挡 ${occluded}px`,
                    `可视底 ${Math.round(visibleBottom)}`,
                    `innerH ${window.innerHeight}`,
                    `vvH ${viewport ? Math.round(viewport.height) : "-"}`,
                    `--- 峰值 ---`,
                    `遮挡峰 ${peakOccluded}`,
                    `抬升峰 ${peakApplied}`,
                    `innerH低 ${minInnerH === Number.POSITIVE_INFINITY ? "-" : Math.round(minInnerH)}`,
                    `vvH低 ${minVvH === Number.POSITIVE_INFINITY ? "-" : Math.round(minVvH)}`,
                    vkInfo(),
                    `已抬 ${applied}`,
                    `样式t ${el.style.transform ? "有" : "无"}`,
                ].join("\n"));
            }

            if (occluded < MIN_OCCLUSION_PX) {
                reset(el);
                return;
            }

            // 上限为整个可视区高度，防止异常数值把输入栏推到屏幕之外。
            const maxLocal = Math.max(0, Math.round(visibleBottom / safeScale));
            const local = Math.min(Math.round(occluded / safeScale), maxLocal);
            if (local <= 0) {
                reset(el);
                return;
            }

            if (savedTransform === null) {
                savedTransform = el.style.getPropertyValue("transform") || "";
                savedPriority = el.style.getPropertyPriority("transform") || "";
            }
            // 用 important：输入栏类里可能带 transform（如 translateZ(0) 之类），
            // 普通内联样式会被类规则压过，导致位移不生效。
            el.style.setProperty("transform", `translateY(${-local}px)`, "important");
            el.dataset.keyboardInset = String(local);
            applied = local;
            if (local > peakApplied) peakApplied = local;
        };

        const schedule = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(measure);
        };

        // 键盘弹出/收起有动画期，焦点变化后再补几次延迟重算。
        const scheduleSettled = () => {
            schedule();
            for (const delay of [80, 300]) {
                timers.push(window.setTimeout(schedule, delay));
            }
        };

        // 输入栏可能晚于本 hook 挂载（例如首次渲染走了通话等提前 return 分支），
        // 找不到元素时靠观察器补挂，避免 effect 只跑一次就永久失效。
        const observer = typeof MutationObserver !== "undefined"
            ? new MutationObserver(() => schedule())
            : null;
        observer?.observe(wrapper, { childList: true, subtree: false });

        measure();
        viewport?.addEventListener("resize", schedule);
        viewport?.addEventListener("scroll", schedule);
        window.addEventListener("resize", schedule);
        window.addEventListener("focusin", scheduleSettled);
        window.addEventListener("focusout", scheduleSettled);

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            for (const timer of timers) window.clearTimeout(timer);
            observer?.disconnect();
            viewport?.removeEventListener("resize", schedule);
            viewport?.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("focusin", scheduleSettled);
            window.removeEventListener("focusout", scheduleSettled);
            const cleanupTarget = findInputBar(wrapper).el;
            if (cleanupTarget) reset(cleanupTarget);
            document.getElementById(DEBUG_BADGE_ID)?.remove();
        };
    }, [wrapperRef, refreshKey]);
}
