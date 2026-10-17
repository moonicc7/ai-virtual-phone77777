"use client";

import { useEffect, type RefObject } from "react";

/**
 * 键盘遮挡补偿（仅聊天输入栏）。
 *
 * 背景：部分安卓浏览器使用「覆盖式键盘」——软键盘浮在页面上方，但既不缩小
 * window.innerHeight、也不改变 visualViewport、更没有 navigator.virtualKeyboard。
 * 实测该设备键盘弹起前后 innerHeight / visualViewport.height 恒为 677，
 * 遮挡量恒为 0：网页侧拿不到任何键盘存在的信号，基于测量的方案必然失效。
 * 而 Chromium 系（Chrome / Edge / 夸克）会自行处理键盘，不需要也不允许重复抬升。
 *
 * 因此采用「先探测、再补偿」：
 *   输入框获得焦点后观察一小段时间视口变化——
 *     · 视口明显缩小 → 浏览器自己处理了键盘，完全不干预；
 *     · 视口毫无变化 → 判定为覆盖式键盘，按校准值抬起输入栏。
 * 这样同一套代码在两类浏览器上都不会误伤。
 */

/** 覆盖式键盘的实测抬升量（屏幕像素，用户校准得出）。 */
const OVERLAY_LIFT_PX = 235;
/** 校准值可被本地覆盖，便于以后微调而无需改代码。 */
const STORAGE_KEY = "chat-kb-lift-px";
/** 视口缩小超过该值，判定浏览器自己处理了键盘。地址栏伸缩约 86px，不会误触发。 */
const NATIVE_SHRINK_THRESHOLD = 120;
/** 焦点后的观察窗口与轮询间隔。 */
const DETECT_WINDOW_MS = 500;
const DETECT_STEP_MS = 50;

const INPUT_BAR_SELECTOR = '[data-ui="input"], .chat-input-bar';

function isInputBar(el: HTMLElement): boolean {
    return el.dataset.ui === "input" || el.classList.contains("chat-input-bar");
}

/**
 * 找真正可见的输入栏：聊天室可能同时存在多个候选（旧实例未卸载等），
 * 取面积最大的那个，避免选中隐藏元素。
 */
function findInputBar(wrapper: HTMLElement): HTMLElement | null {
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
    return best;
}

function hasEditableFocus(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el instanceof HTMLElement && el.isContentEditable;
}

function readLift(): number {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const value = raw ? Number(raw) : NaN;
        if (Number.isFinite(value) && value > 0) return Math.round(value);
    } catch {
        // 隐私模式下 localStorage 可能抛错，用默认值即可。
    }
    return OVERLAY_LIFT_PX;
}

export function useChatKeyboardInset<TWrapper extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    refreshKey: string,
) {
    useEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        const lift = readLift();
        let appliedLocal = 0;
        let savedTransform: string | null = null;
        let savedPriority = "";
        let frame = 0;
        let detectTimer = 0;
        let detectElapsed = 0;
        let baseInnerH = 0;
        let baseVvH = 0;
        const timers: number[] = [];

        const clearLift = () => {
            if (appliedLocal === 0 && savedTransform === null) return;
            const el = findInputBar(wrapper);
            if (el) {
                if (savedTransform === null) {
                    el.style.removeProperty("transform");
                } else {
                    el.style.setProperty("transform", savedTransform, savedPriority || "");
                }
                delete el.dataset.keyboardInset;
            }
            savedTransform = null;
            savedPriority = "";
            appliedLocal = 0;
        };

        const applyLift = () => {
            frame = 0;
            if (!hasEditableFocus() || lift <= 0) {
                clearLift();
                return;
            }
            const el = findInputBar(wrapper);
            if (!el) return;

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                clearLift();
                return;
            }

            // 实测缩放比：手机壳在窄视口下整体缩放，translateY 作用在缩放之前，
            // 必须换算，否则抬不到位或抬过头。
            const layoutWidth = el.offsetWidth || 0;
            const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
            const safeScale = scale > 0.1 ? scale : 1;
            const local = Math.round(lift / safeScale);
            if (local <= 0) {
                clearLift();
                return;
            }

            if (savedTransform === null) {
                savedTransform = el.style.getPropertyValue("transform") || "";
                savedPriority = el.style.getPropertyPriority("transform") || "";
            }
            // 用 important：类规则里的 transform 会压过普通内联样式。
            el.style.setProperty("transform", `translateY(${-local}px)`, "important");
            el.dataset.keyboardInset = String(local);
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
            if (!hasEditableFocus()) {
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
                    applyLift();
                    return;
                }
                detectTimer = window.setTimeout(tick, DETECT_STEP_MS);
            };
            detectTimer = window.setTimeout(tick, DETECT_STEP_MS);
        };

        const scheduleApply = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(applyLift);
        };

        // 键盘弹出/收起有动画期，焦点变化后再补几次。
        const scheduleSettled = () => {
            scheduleApply();
            for (const delay of [80, 300]) {
                timers.push(window.setTimeout(scheduleApply, delay));
            }
        };

        // 输入栏可能晚于 hook 挂载（首次渲染走了通话等提前 return 分支），
        // 用观察器补挂，避免 effect 只跑一次就永久失效。
        const observer = typeof MutationObserver !== "undefined"
            ? new MutationObserver(() => {
                if (hasEditableFocus()) scheduleSettled();
            })
            : null;
        observer?.observe(wrapper, { childList: true, subtree: false });

        const onFocusIn = () => startDetect();
        const onFocusOut = () => {
            stopDetect();
            // 失焦后键盘会收起；稍等再清，避免点到另一个输入框时闪动。
            timers.push(window.setTimeout(() => {
                if (!hasEditableFocus()) clearLift();
            }, 120));
        };

        window.addEventListener("focusin", onFocusIn);
        window.addEventListener("focusout", onFocusOut);
        window.visualViewport?.addEventListener("resize", scheduleApply);

        // 进入聊天室时输入框可能已有焦点（如从别处跳回），补一次探测。
        if (hasEditableFocus()) startDetect();

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            stopDetect();
            for (const timer of timers) window.clearTimeout(timer);
            observer?.disconnect();
            window.removeEventListener("focusin", onFocusIn);
            window.removeEventListener("focusout", onFocusOut);
            window.visualViewport?.removeEventListener("resize", scheduleApply);
            clearLift();
        };
    }, [wrapperRef, refreshKey]);
}
