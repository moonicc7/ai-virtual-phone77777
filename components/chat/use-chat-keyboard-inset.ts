"use client";

import { useEffect, type RefObject } from "react";

/**
 * 键盘遮挡补偿（仅聊天输入栏）。
 *
 * 背景：Firefox for Android 在软键盘弹出时不缩小视口，而聊天输入栏是
 * position:absolute 钉在手机壳底部，于是键盘直接把它盖住，用户看不见自己
 * 打的字。Chromium 系（Chrome / Edge / 夸克）会自行缩小视口或把输入框滚进
 * 视野，不需要也不允许我们再抬一次——否则输入栏被抬两次会飞出屏幕。
 *
 * 判定原则：直接量「输入栏底边超出可视区底边的距离」。
 *   - 浏览器已经处理好 → 超出量 ≈ 0 → 不补偿（其余浏览器行为完全不变）；
 *   - 浏览器没处理（Firefox）→ 超出量 = 被键盘盖住的真实高度 → 抬这么多。
 * 这样在任何浏览器上都遵循「已经可见就不动」，天然不会误伤。
 *
 * 手机壳在窄视口下是整体 CSS 缩放显示的，而 translateY 作用在缩放之前，
 * 因此必须除以实测缩放比，否则会抬不到位或抬过头。
 */

/** 小于该值视为噪声（地址栏伸缩、圆角溢出等），不做补偿。 */
const MIN_OCCLUSION_PX = 12;

function hasEditableFocus(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el instanceof HTMLElement && el.isContentEditable;
}

/** 与 use-chat-bottom-reserve 一致：输入栏是 wrapper 的直接子元素。 */
function findInputBar(wrapper: HTMLElement): HTMLElement | null {
    for (const child of Array.from(wrapper.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.dataset.ui === "input") return child;
    }
    return null;
}

export function useChatKeyboardInset<TWrapper extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    refreshKey: string,
) {
    useEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        const viewport = window.visualViewport;
        // 不支持 visualViewport 的旧浏览器直接跳过，保持原样。
        if (!viewport) return;

        let applied = 0;
        let frame = 0;
        let savedTransform: string | null = null;
        const timers: number[] = [];

        const reset = (el: HTMLElement) => {
            if (applied === 0 && savedTransform === null) return;
            el.style.transform = savedTransform ?? "";
            savedTransform = null;
            applied = 0;
        };

        const measure = () => {
            frame = 0;
            const el = findInputBar(wrapper);
            if (!el) {
                // 多选模式下输入栏会卸载：清掉簿记，避免残留的 transform
                // 被下次挂载的新元素继承。
                applied = 0;
                savedTransform = null;
                return;
            }

            // 没有可编辑元素聚焦 = 不可能有键盘，直接归零。
            // 这一条同时兜住「键盘收起却不触发 resize」的情况，避免输入栏
            // 永远卡在抬升状态、底部露出空白。
            if (!hasEditableFocus()) {
                reset(el);
                return;
            }

            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                reset(el);
                return;
            }

            // 实测缩放比：布局宽度 offsetWidth → 屏幕宽度 rect.width。
            // 必须先算，因为 rect 里含当前 transform 的位移，要还原成未抬升的位置再判断。
            const layoutWidth = el.offsetWidth || 0;
            const scale = layoutWidth > 0 ? rect.width / layoutWidth : 1;
            const safeScale = scale > 0.1 ? scale : 1;

            // 关键：rect.bottom 包含我们上一轮加的位移，直接拿来判断会形成
            // 反馈环——抬起来→看起来没被遮挡→还原→又遮挡→再抬，输入框会抖。
            // 因此先把已施加的位移加回去，得到「未抬升时」的底边，再决定要不要抬。
            const appliedScreen = applied * safeScale;
            const visibleBottom = viewport.offsetTop + viewport.height;
            const occluded = Math.round(rect.bottom + appliedScreen - visibleBottom);
            if (occluded < MIN_OCCLUSION_PX) {
                reset(el);
                return;
            }

            // 上限为可视区高度的一半，防止异常数值把输入栏推到屏幕之外。
            const maxLocal = Math.max(0, Math.round((viewport.height / 2) / safeScale));
            const local = Math.min(Math.round(occluded / safeScale), maxLocal);
            if (local <= 0) {
                reset(el);
                return;
            }

            if (savedTransform === null) savedTransform = el.style.transform;
            el.style.transform = `translateY(${-local}px)`;
            applied = local;
        };

        const schedule = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(measure);
        };

        // 焦点切换时键盘高度会变，resize 之外再补几次延迟重算，
        // 覆盖键盘弹出/收起的动画期。
        const scheduleSettled = () => {
            schedule();
            for (const delay of [80, 300]) {
                timers.push(window.setTimeout(schedule, delay));
            }
        };

        measure();
        viewport.addEventListener("resize", schedule);
        viewport.addEventListener("scroll", schedule);
        window.addEventListener("resize", schedule);
        window.addEventListener("focusin", scheduleSettled);
        window.addEventListener("focusout", scheduleSettled);

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            for (const timer of timers) window.clearTimeout(timer);
            viewport.removeEventListener("resize", schedule);
            viewport.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("focusin", scheduleSettled);
            window.removeEventListener("focusout", scheduleSettled);
            const el = findInputBar(wrapper);
            if (el) reset(el);
        };
    }, [wrapperRef, refreshKey]);
}
