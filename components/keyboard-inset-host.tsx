"use client";

import { useEffect } from "react";

/**
 * 键盘遮挡补偿（覆盖式键盘专用）。
 *
 * 背景：这台设备的浏览器使用覆盖式键盘——软键盘浮在页面上方，但既不缩小
 * window.innerHeight、也不改变 visualViewport、更没有 navigator.virtualKeyboard。
 * 实测键盘弹起前后 innerHeight / visualViewport.height 恒为 677，网页拿不到
 * 任何键盘信号，因此只能按经验值抬升。而 Chromium 系（Chrome / Edge / 夸克）
 * 会自行处理键盘，绝不能重复抬升，否则输入框会飞出屏幕。
 *
 * 策略：先探测、再补偿。
 *   输入框获得焦点后观察一小段视口变化——
 *     · 视口缩小超过 120px → 浏览器自己让出了键盘空间，完全不干预；
 *     · 视口毫无变化 → 判定为覆盖式键盘，按白名单抬升。
 *
 * 只处理白名单里的四个容器（用户实测需要抬升的就这几处）：
 *   .chat-input-bar   聊天室输入栏（小卷面板复用同一个类）
 *   .story-composer   剧情 App 输入栏
 *   .qa-composer-wrap 答疑 App 输入栏
 * 其余输入框一律不动，避免误伤其他页面。
 */

/** 需要抬升的容器：类名 → 抬升量（屏幕像素，实测校准值）。 */
const LIFT_TARGETS: Array<{ className: string; lift: number }> = [
    { className: "chat-input-bar", lift: 235 },
    { className: "story-composer", lift: 235 },
    { className: "qa-composer-wrap", lift: 235 },
];

/** 视口缩小超过该值，判定浏览器自己处理了键盘。地址栏伸缩约 86px，不会误触发。 */
const NATIVE_SHRINK_THRESHOLD = 120;
/** 焦点后的观察窗口与轮询间隔。窗口越短越跟手。 */
const DETECT_WINDOW_MS = 200;
const DETECT_STEP_MS = 40;
/** 向上找几层祖先，超出即认为没有匹配的容器。 */
const MAX_ANCESTOR_DEPTH = 14;

function hasEditableFocus(): Element | null {
    const el = document.activeElement;
    if (!el) return null;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return el;
    return el instanceof HTMLElement && el.isContentEditable ? el : null;
}

/**
 * 从焦点元素向上找白名单容器，返回命中的那个与对应抬升量。
 * 找不到返回 null —— 该输入框不在处理范围内，一律不动。
 */
function findLiftTarget(focusEl: Element): { el: HTMLElement; lift: number } | null {
    let node: Element | null = focusEl;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && node; depth += 1) {
        if (node instanceof HTMLElement) {
            for (const rule of LIFT_TARGETS) {
                if (node.classList.contains(rule.className)) {
                    return { el: node, lift: rule.lift };
                }
            }
        }
        node = node.parentElement;
    }
    return null;
}

export function KeyboardInsetHost() {
    useEffect(() => {
        if (typeof window === "undefined") return;

        let target: HTMLElement | null = null;
        let appliedLocal = 0;
        let savedTransform: string | null = null;
        let savedPriority = "";
        let detectTimer = 0;
        let detectElapsed = 0;
        let baseInnerH = 0;
        let baseVvH = 0;
        const timers: number[] = [];

        const clearLift = () => {
            if (target && (appliedLocal !== 0 || savedTransform !== null)) {
                if (savedTransform === null) {
                    target.style.removeProperty("transform");
                } else {
                    target.style.setProperty("transform", savedTransform, savedPriority || "");
                }
                target.style.removeProperty("transition");
                delete target.dataset.keyboardInset;
            }
            savedTransform = null;
            savedPriority = "";
            appliedLocal = 0;
            target = null;
        };

        const applyLift = (lift: number) => {
            const focusEl = hasEditableFocus();
            if (!focusEl || lift <= 0) {
                clearLift();
                return;
            }
            const hit = findLiftTarget(focusEl);
            if (!hit) {
                // 不在白名单内：不处理。
                clearLift();
                return;
            }
            target = hit.el;

            const rect = target.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                clearLift();
                return;
            }

            // 实测缩放比：手机壳在窄视口下整体缩放，translateY 作用在缩放之前，
            // 必须换算，否则抬不到位或抬过头。
            const layoutWidth = target.offsetWidth || 0;
            const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
            const safeScale = scale > 0.1 ? scale : 1;
            const local = Math.round(lift / safeScale);
            if (local <= 0) {
                clearLift();
                return;
            }

            if (savedTransform === null) {
                savedTransform = target.style.getPropertyValue("transform") || "";
                savedPriority = target.style.getPropertyPriority("transform") || "";
            }
            // 短过渡：直接跳变生硬，120ms 足够顺滑又不拖沓。
            target.style.setProperty("transition", "transform 120ms ease-out", "important");
            // 用 important：类规则里的 transform 会压过普通内联样式。
            target.style.setProperty("transform", `translateY(${-local}px)`, "important");
            target.dataset.keyboardInset = String(local);
            appliedLocal = local;
        };

        const stopDetect = () => {
            if (detectTimer) window.clearTimeout(detectTimer);
            detectTimer = 0;
            detectElapsed = 0;
        };

        /**
         * 焦点进入后先观察视口：缩了就是浏览器自己处理，什么都不做；
         * 一直不缩才认定是覆盖式键盘，此时才抬。
         */
        const startDetect = () => {
            stopDetect();
            const focusEl = hasEditableFocus();
            if (!focusEl) {
                clearLift();
                return;
            }
            // 不在白名单内直接退出，连探测都不做。
            const hit = findLiftTarget(focusEl);
            if (!hit) {
                clearLift();
                return;
            }

            baseInnerH = window.innerHeight;
            baseVvH = window.visualViewport?.height ?? window.innerHeight;
            detectElapsed = 0;

            const tick = () => {
                detectTimer = 0;
                if (!hasEditableFocus()) {
                    stopDetect();
                    clearLift();
                    return;
                }
                const innerH = window.innerHeight;
                const vvH = window.visualViewport?.height ?? innerH;
                const shrunk =
                    innerH < baseInnerH - NATIVE_SHRINK_THRESHOLD ||
                    vvH < baseVvH - NATIVE_SHRINK_THRESHOLD;
                if (shrunk) {
                    // 浏览器自己让出了键盘空间，绝不能重复抬升。
                    stopDetect();
                    clearLift();
                    return;
                }
                detectElapsed += DETECT_STEP_MS;
                if (detectElapsed >= DETECT_WINDOW_MS) {
                    stopDetect();
                    applyLift(hit.lift);
                    return;
                }
                detectTimer = window.setTimeout(tick, DETECT_STEP_MS);
            };
            detectTimer = window.setTimeout(tick, DETECT_STEP_MS);
        };

        const onFocusIn = () => startDetect();
        const onFocusOut = () => {
            stopDetect();
            // 失焦后键盘会收起；稍等再清，避免点到另一个输入框时闪动。
            timers.push(window.setTimeout(() => {
                if (!hasEditableFocus()) clearLift();
            }, 100));
        };

        window.addEventListener("focusin", onFocusIn);
        window.addEventListener("focusout", onFocusOut);

        if (hasEditableFocus()) startDetect();

        return () => {
            stopDetect();
            for (const timer of timers) window.clearTimeout(timer);
            window.removeEventListener("focusin", onFocusIn);
            window.removeEventListener("focusout", onFocusOut);
            clearLift();
        };
    }, []);

    return null;
}
