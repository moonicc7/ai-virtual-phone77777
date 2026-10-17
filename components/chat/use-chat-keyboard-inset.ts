"use client";

import { useEffect, type RefObject } from "react";

/**
 * 键盘遮挡补偿（仅聊天输入栏）。
 *
 * 背景：部分安卓浏览器（如覆盖式键盘的第三方浏览器）在软键盘弹出时，
 * 既不缩小 window.innerHeight、也不改变 visualViewport、更没有
 * navigator.virtualKeyboard——网页侧完全拿不到「键盘存在」的任何信号。
 * 实测：innerHeight / visualViewport.height 在键盘弹起前后恒为 677，
 * 遮挡量恒为 0。这类浏览器上任何基于测量的方案都必然失败。
 *
 * 因此改用焦点驱动的经验补偿：
 *   - 可编辑元素获得焦点 → 按校准高度抬起输入栏；
 *   - 失焦 → 放下。
 * 校准值存在 localStorage，首次使用取可视区高度的 40% 作为默认值，
 * 并提供屏幕上的 ± 按钮供用户调到自己键盘的实际高度。
 *
 * 手机壳在窄视口下整体缩放显示，translateY 作用在缩放之前，
 * 写入前必须除以实测缩放比。
 */

/** 输入栏标识：优先 data-ui，兜底类名。 */
const INPUT_BAR_SELECTOR = '[data-ui="input"], .chat-input-bar';
/** 校准值（屏幕像素）存储键。 */
const STORAGE_KEY = "chat-kb-lift-px";
/** 默认抬升比例：可视区高度的 40%，接近常见安卓键盘占比。 */
const DEFAULT_RATIO = 0.4;
const STEP_PX = 12;

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
        // 隐私模式下 localStorage 可能抛错，忽略即可。
    }
    return Math.round((window.visualViewport?.height || window.innerHeight || 640) * DEFAULT_RATIO);
}

function writeLift(px: number) {
    try {
        window.localStorage.setItem(STORAGE_KEY, String(Math.round(px)));
    } catch {
        // 存不了就只在本次会话生效。
    }
}

// ── 临时校准面板（校准完成、数值写死后整块删除）──────────────────
const PANEL_ID = "__kb_lift_panel";

function renderPanel(lift: number, onStep: (delta: number) => void) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.style.cssText = [
            "position:fixed", "left:8px", "top:8px", "z-index:2147483647",
            "display:flex", "align-items:center", "gap:6px",
            "padding:4px 8px", "border-radius:6px",
            "background:rgba(0,0,0,.88)", "color:#0f0", "font:12px/1.4 monospace",
            "pointer-events:auto", "user-select:none",
        ].join(";");
        document.body.appendChild(panel);
    }
    panel.textContent = "";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.style.cssText = "font:14px monospace;padding:0 6px;background:#333;color:#0f0;border:0;border-radius:4px;";
    minus.onclick = () => onStep(-STEP_PX);

    const label = document.createElement("span");
    label.textContent = `抬升 ${lift}px`;

    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.style.cssText = minus.style.cssText;
    plus.onclick = () => onStep(STEP_PX);

    panel.append(minus, label, plus);
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

        let lift = readLift();
        let appliedLocal = 0;
        let savedTransform: string | null = null;
        let savedPriority = "";
        let frame = 0;
        const timers: number[] = [];

        const clearLift = (el: HTMLElement) => {
            if (appliedLocal === 0 && savedTransform === null) return;
            if (savedTransform === null) {
                el.style.removeProperty("transform");
            } else {
                el.style.setProperty("transform", savedTransform, savedPriority || "");
            }
            delete el.dataset.keyboardInset;
            savedTransform = null;
            savedPriority = "";
            appliedLocal = 0;
        };

        const applyLift = () => {
            frame = 0;
            const el = findInputBar(wrapper);
            if (!el) return;

            if (!hasEditableFocus() || lift <= 0) {
                clearLift(el);
                return;
            }

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                clearLift(el);
                return;
            }

            // 实测缩放比：translateY 作用在缩放之前，必须换算。
            const layoutWidth = el.offsetWidth || 0;
            const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
            const safeScale = scale > 0.1 ? scale : 1;
            const local = Math.round(lift / safeScale);
            if (local <= 0) {
                clearLift(el);
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

        const schedule = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(applyLift);
        };

        // 键盘弹出有动画期，焦点变化后分批重算。
        const scheduleSettled = () => {
            schedule();
            for (const delay of [80, 300, 600]) {
                timers.push(window.setTimeout(schedule, delay));
            }
        };

        const stepLift = (delta: number) => {
            lift = Math.max(0, Math.min(600, lift + delta));
            writeLift(lift);
            renderPanel(lift, stepLift);
            scheduleSettled();
        };

        const observer = typeof MutationObserver !== "undefined"
            ? new MutationObserver(() => schedule())
            : null;
        observer?.observe(wrapper, { childList: true, subtree: false });

        renderPanel(lift, stepLift);
        applyLift();
        window.visualViewport?.addEventListener("resize", schedule);
        window.visualViewport?.addEventListener("scroll", schedule);
        window.addEventListener("resize", schedule);
        window.addEventListener("focusin", scheduleSettled);
        window.addEventListener("focusout", scheduleSettled);

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            for (const timer of timers) window.clearTimeout(timer);
            observer?.disconnect();
            window.visualViewport?.removeEventListener("resize", schedule);
            window.visualViewport?.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("focusin", scheduleSettled);
            window.removeEventListener("focusout", scheduleSettled);
            const el = findInputBar(wrapper);
            if (el) clearLift(el);
            document.getElementById(PANEL_ID)?.remove();
        };
    }, [wrapperRef, refreshKey]);
}
