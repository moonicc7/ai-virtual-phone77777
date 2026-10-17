"use client";

import { useEffect } from "react";

/**
 * 全局键盘遮挡补偿（覆盖式键盘专用）+ 临时诊断面板。
 *
 * 背景：部分安卓浏览器（如这台设备上的第三方浏览器）使用覆盖式键盘——
 * 软键盘浮在页面上方，但既不缩小 window.innerHeight、也不改变
 * visualViewport、更没有 navigator.virtualKeyboard。实测键盘弹起前后
 * innerHeight / visualViewport.height 恒为 677，网页拿不到任何键盘信号，
 * 因此只能按经验值抬升。而 Chromium 系（Chrome / Edge / 夸克）会自行处理，
 * 绝不能重复抬升，否则输入框会飞出屏幕。
 *
 * 策略：先探测、再补偿。
 *   输入框获得焦点后观察一小段视口变化——
 *     · 视口缩小超过 120px → 浏览器自己让出了键盘空间，完全不干预；
 *     · 视口毫无变化 → 判定为覆盖式键盘，把输入框所在容器抬起。
 *
 * 抬升对象：焦点元素最近的「吸附容器」——自身或祖先里 position 为
 * absolute / fixed 的元素。找不到则不抬（普通文档流输入框由页面自身滚动处理）。
 *
 * 诊断面板：每个 App 的输入框容器结构可能不同，面板会实时显示当前
 * 识别到的容器、抬升量，并提供 −/+ 微调，便于逐页校准。
 */

/** 覆盖式键盘的默认抬升量（屏幕像素）。 */
const DEFAULT_LIFT_PX = 235;
/** 抬升量按 App 分别存储：不同容器可能需要不同数值。 */
const STORAGE_PREFIX = "kb-lift:";
/** 视口缩小超过该值，判定浏览器自己处理了键盘。地址栏伸缩约 86px，不会误触发。 */
const NATIVE_SHRINK_THRESHOLD = 120;
/** 焦点后的观察窗口与轮询间隔。窗口越短越跟手。 */
const DETECT_WINDOW_MS = 200;
const DETECT_STEP_MS = 40;
/** 向上找几层祖先，超出即认为没有可抬升的吸附容器。 */
const MAX_ANCESTOR_DEPTH = 14;
const STEP_PX = 12;

function hasEditableFocus(): Element | null {
    const el = document.activeElement;
    if (!el) return null;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return el;
    return el instanceof HTMLElement && el.isContentEditable ? el : null;
}

function isAbsorbed(el: HTMLElement): boolean {
    const position = window.getComputedStyle(el).position;
    return position === "absolute" || position === "fixed";
}

/** 焦点元素最近的吸附容器。 */
function findLiftTarget(focusEl: Element): HTMLElement | null {
    let node: Element | null = focusEl;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && node; depth += 1) {
        if (node instanceof HTMLElement && isAbsorbed(node)) return node;
        node = node.parentElement;
    }
    return null;
}

/** 给元素起个便于辨认的短名：优先 data-ui / 首类名 / 标签名。 */
function describe(el: Element | null): string {
    if (!el) return "无";
    if (!(el instanceof HTMLElement)) return el.tagName.toLowerCase();
    const ui = el.dataset.ui;
    if (ui) return `[ui=${ui}]`;
    const cls = el.classList[0];
    if (cls) return `.${cls}`;
    return el.tagName.toLowerCase();
}

/** 当前所在的 App 名（用于分 App 存抬升量）。 */
function currentAppKey(): string {
    const focusEl = hasEditableFocus();
    let node: Element | null = focusEl;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && node; depth += 1) {
        if (node instanceof HTMLElement) {
            const cls = Array.from(node.classList).find(c =>
                /(?:^|-)(app|shell|page|room)(?:-|$)/i.test(c),
            );
            if (cls) return cls;
        }
        node = node.parentElement;
    }
    return "default";
}

function readLift(key: string): number {
    try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
        const value = raw ? Number(raw) : NaN;
        if (Number.isFinite(value) && value > 0) return Math.round(value);
    } catch {
        // 隐私模式下 localStorage 可能抛错，用默认值即可。
    }
    return DEFAULT_LIFT_PX;
}

function writeLift(key: string, px: number) {
    try {
        window.localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(px)));
    } catch {
        // 存不了就只在本次会话生效。
    }
}

// ── 临时诊断面板（调试完成、数值写死后整块删除）──────────────────
const PANEL_ID = "__kb_panel";

type PanelState = {
    appKey: string;
    lift: number;
    targetName: string;
    focusName: string;
    applied: number;
    shrunk: boolean;
    onStep: (delta: number) => void;
};

function renderPanel(state: PanelState) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.style.cssText = [
            "position:fixed", "left:6px", "top:6px", "z-index:2147483647",
            "max-width:82vw", "padding:5px 7px", "border-radius:7px",
            "background:rgba(0,0,0,.9)", "color:#0f0", "font:11px/1.45 monospace",
            "pointer-events:auto", "user-select:none", "white-space:pre-wrap",
            "word-break:break-all",
        ].join(";");
        document.body.appendChild(panel);
    }
    panel.textContent = "";

    const info = document.createElement("div");
    info.textContent = [
        `App ${state.appKey}`,
        `焦点 ${state.focusName}`,
        `容器 ${state.targetName}`,
        `抬升 ${state.lift}px`,
        `已抬 ${state.applied}`,
        state.shrunk ? "浏览器已处理" : "覆盖式键盘",
    ].join("\n");

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:4px;";

    const mkBtn = (label: string, delta: number) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = "font:13px monospace;padding:1px 7px;background:#2b2b2b;color:#0f0;border:1px solid #0f0;border-radius:4px;";
        b.onclick = () => state.onStep(delta);
        return b;
    };

    row.append(mkBtn("−", -STEP_PX), mkBtn("+", STEP_PX));
    panel.append(info, row);
}
// ──────────────────────────────────────────────────────────────

export function KeyboardInsetHost() {
    useEffect(() => {
        if (typeof window === "undefined") return;

        let appKey = "default";
        let lift = readLift(appKey);
        let target: HTMLElement | null = null;
        let appliedLocal = 0;
        let savedTransform: string | null = null;
        let savedPriority = "";
        let detectTimer = 0;
        let detectElapsed = 0;
        let baseInnerH = 0;
        let baseVvH = 0;
        let browserHandled = false;
        const timers: number[] = [];

        const paint = () => {
            renderPanel({
                appKey,
                lift,
                targetName: describe(target),
                focusName: describe(hasEditableFocus()),
                applied: appliedLocal,
                shrunk: browserHandled,
                onStep: (delta) => {
                    lift = Math.max(0, Math.min(600, lift + delta));
                    writeLift(appKey, lift);
                    applyLift();
                    paint();
                },
            });
        };

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
        };

        const applyLift = () => {
            const focusEl = hasEditableFocus();
            if (!focusEl || lift <= 0) {
                clearLift();
                paint();
                return;
            }
            if (!target) {
                target = findLiftTarget(focusEl);
                if (!target) {
                    paint();
                    return;
                }
            }

            const rect = target.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                clearLift();
                paint();
                return;
            }

            // 实测缩放比：手机壳在窄视口下整体缩放，translateY 作用在缩放之前。
            const layoutWidth = target.offsetWidth || 0;
            const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
            const safeScale = scale > 0.1 ? scale : 1;
            const local = Math.round(lift / safeScale);
            if (local <= 0) {
                clearLift();
                paint();
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
            paint();
        };

        const stopDetect = () => {
            if (detectTimer) window.clearTimeout(detectTimer);
            detectTimer = 0;
            detectElapsed = 0;
        };

        const startDetect = () => {
            stopDetect();
            browserHandled = false;
            if (!hasEditableFocus()) {
                clearLift();
                paint();
                return;
            }
            appKey = currentAppKey();
            lift = readLift(appKey);
            target = null;
            baseInnerH = window.innerHeight;
            baseVvH = window.visualViewport?.height ?? window.innerHeight;
            detectElapsed = 0;
            paint();

            const tick = () => {
                detectTimer = 0;
                if (!hasEditableFocus()) {
                    stopDetect();
                    clearLift();
                    paint();
                    return;
                }
                const innerH = window.innerHeight;
                const vvH = window.visualViewport?.height ?? innerH;
                const shrunk =
                    innerH < baseInnerH - NATIVE_SHRINK_THRESHOLD ||
                    vvH < baseVvH - NATIVE_SHRINK_THRESHOLD;
                if (shrunk) {
                    // 浏览器自己让出了键盘空间，绝不能重复抬升。
                    browserHandled = true;
                    stopDetect();
                    clearLift();
                    paint();
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

        const onFocusIn = () => startDetect();
        const onFocusOut = () => {
            stopDetect();
            // 失焦后键盘会收起；稍等再清，避免点到另一个输入框时闪动。
            timers.push(window.setTimeout(() => {
                if (!hasEditableFocus()) {
                    clearLift();
                    paint();
                }
            }, 100));
        };

        window.addEventListener("focusin", onFocusIn);
        window.addEventListener("focusout", onFocusOut);

        if (hasEditableFocus()) startDetect();
        paint();

        return () => {
            stopDetect();
            for (const timer of timers) window.clearTimeout(timer);
            window.removeEventListener("focusin", onFocusIn);
            window.removeEventListener("focusout", onFocusOut);
            clearLift();
            document.getElementById(PANEL_ID)?.remove();
        };
    }, []);

    return null;
}
