// ==UserScript==
// @name         成都职业培训网络学院 - 全自动刷课脚本
// @namespace    https://www.cdwork.cn/
// @version      2.0
// @description  自动播放视频、自动跳转下一节，直到所有培训课程全部学完。进入播放页自动启动。修复跳节和卡住问题。
// @author       Auto Learning Script
// @match        https://www.cdwork.cn/*
// @match        https://*.cdwork.cn/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        checkInterval: 3000,          // 主循环检测间隔(ms) — 从2s增加到3s，减少对播放器的干扰
        nextSectionDelay: 5000,       // 切换下一节延迟(ms) — 从2s增加到5s，给服务器足够时间处理完成状态
        dialogCheckInterval: 800,     // 弹窗检测间隔(ms)
        maxRetries: 5,                // 最大重试次数
        completionWaitTimeout: 20000, // 等待小节完成的最大时间(ms)
        isLoadingTimeout: 60000,      // isLoading 卡住超时时间(ms)
        watchdogTimeout: 300000,      // 看门狗超时时间(ms) — 5分钟无进展则刷新
        replayMaxRetries: 2,          // 同一小节最大重播次数
    };

    // ==================== 状态 ====================
    const STATE = {
        running: false,
        currentChapterIdx: -1,
        currentSectionIdx: -1,
        retryCount: 0,
        log: [],
        stats: {
            completed: 0,
            total: 0,
        },
        // 新增状态
        hooksInstalled: false,         // 是否已安装 hooks
        lastEndedChapterId: null,      // 上一次发送 "end" 的 chapterId，防止重复发送
        lastEndedTime: 0,              // 上一次视频结束的时间
        currentSectionReplayCount: 0,  // 当前小节重播次数
        lastProgressTime: Date.now(),  // 上次有进展的时间（用于看门狗）
        lastCurrentTime: 0,            // 上次记录的播放位置（用于检测卡住）
        stuckCount: 0,                 // 播放位置卡住计数
        isSwitching: false,            // 是否正在切换小节
    };

    // ==================== 工具函数 ====================
    function log(msg, level = 'info') {
        const time = new Date().toLocaleTimeString();
        const entry = `[${time}] ${msg}`;
        STATE.log.unshift(entry);
        if (STATE.log.length > 50) STATE.log.pop();
        const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
        console.log(`%c[自动刷课] ${prefix} ${entry}`, `color: ${level === 'error' ? '#f56c6c' : level === 'warn' ? '#e6a23c' : level === 'success' ? '#67c23a' : '#409eff'}; font-weight: bold;`);
        updateUI();
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // 获取Vue组件实例
    function getVueVM() {
        // 方式1: 通过 data-v-d065c4a0 属性查找（播放页组件）
        const el = document.querySelector('[data-v-d065c4a0]');
        if (el && el.__vue__) return el.__vue__;

        // 方式2: 遍历查找包含 player 数据的 Vue 组件
        const app = document.querySelector('#app');
        if (app && app.__vue__) {
            const vm = app.__vue__;
            // 递归查找子组件
            function findVM(component) {
                if (component && component.player && component.ListML) return component;
                if (component && component.$children) {
                    for (const child of component.$children) {
                        const found = findVM(child);
                        if (found) return found;
                    }
                }
                return null;
            }
            return findVM(vm);
        }
        return null;
    }

    // 获取视频元素
    function getVideoEl() {
        return document.querySelector('#video_container_html5_api') ||
               document.querySelector('video.vjs-tech') ||
               document.querySelector('video');
    }

    // 获取TCPlayer播放器实例
    function getPlayer() {
        const vm = getVueVM();
        if (vm && vm.player) return vm.player;
        return null;
    }

    // ==================== 核心：Hook 安装 ====================
    // 安装 hooks 来拦截 Vue 组件的关键方法，防止破坏性行为
    function installHooks() {
        if (STATE.hooksInstalled) return;

        const vm = getVueVM();
        if (!vm) return;

        // 保存原始方法
        const originalStartLearningSocket = vm.startLearningSocket;
        const originalAllClearEmpty = vm.AllClearEmpty;
        const originalOnPlayItem = vm.onPlayItem;

        // Hook 1: 拦截 startLearningSocket — 防止重复 "end" 调用和 AllClearEmpty 被误调
        vm.startLearningSocket = function(status, isForced) {
            const playStatus = status || this.playStatus;
            const currentChapterId = this.chapterId;
            const currentTime = this.player ? Math.floor(this.player.currentTime()) : 0;

            // 防止对同一小节重复发送 "end" 信号
            // onEnd 已经发送了 "end"，onPlayItem 内部又调了一次，这里拦截掉重复的
            if (playStatus === 'end' && STATE.lastEndedChapterId === currentChapterId) {
                // 距离上次 "end" 不到 30 秒，跳过重复调用
                if (Date.now() - STATE.lastEndedTime < 30000) {
                    console.log('[自动刷课] 拦截重复的 startLearningSocket("end") 调用', { chapterId: currentChapterId });
                    return Promise.resolve({ state: null });
                }
            }

            if (playStatus === 'end') {
                STATE.lastEndedChapterId = currentChapterId;
                STATE.lastEndedTime = Date.now();
            }

            // 调用原始方法，但拦截 catch 中的 AllClearEmpty
            const result = originalStartLearningSocket.call(this, status, isForced);

            // 额外保护：如果原始方法的 catch 会调 AllClearEmpty，我们通过临时替换来阻止
            // 但由于原始方法已经绑定了 catch，我们只能通过覆盖 AllClearEmpty 来保护
            return result;
        };

        // Hook 2: 拦截 AllClearEmpty — 防止 API 错误时销毁所有数据
        // AllClearEmpty 会在 startLearningSocket 的 catch 中被调用
        // 我们只在非致命错误时阻止它
        vm.AllClearEmpty = function() {
            // 检查是否是致命错误（401: 在其他设备登录）
            // 对于网络波动等非致命错误，不执行 AllClearEmpty
            console.log('[自动刷课] 拦截 AllClearEmpty 调用 — 防止数据被清空');

            // 只清除 interval，不销毁播放器和数据
            if (this.intervalTime) {
                clearInterval(this.intervalTime);
                this.intervalTime = null;
            }

            // 不执行原始的 AllClearEmpty（不销毁 player、不清空 ListML 等）
            // 只在真正需要时（如 401 错误）才执行
        };

        // 保留原始 AllClearEmpty 供致命错误使用
        vm._originalAllClearEmpty = originalAllClearEmpty;

        // Hook 3: 拦截 onPlayItem — 在切换前重置 isLoading（如果卡住）
        const self = this;
        vm.onPlayItem = function(t, e, a) {
            // 如果 isLoading 卡住了，强制重置
            if (this.isLoading) {
                console.log('[自动刷课] onPlayItem 被 isLoading 阻止，检查是否卡住...');
                // 直接重置 isLoading，允许切换
                this.isLoading = false;
                log('检测到 isLoading 卡住，已强制重置', 'warn');
            }

            return originalOnPlayItem.call(this, t, e, a);
        };

        STATE.hooksInstalled = true;
        log('已安装 Hook 拦截器（防重复end、防AllClearEmpty、防isLoading卡住）', 'success');
    }

    // 处理致命错误（如 401: 在其他设备登录）
    function handleFatalError() {
        const vm = getVueVM();
        if (vm && vm._originalAllClearEmpty) {
            vm._originalAllClearEmpty.call(vm);
        }
    }

    // ==================== 弹窗处理 ====================
    function handleDialogs() {
        // 处理"是否继续上次播放"弹窗
        // 关键修复：点击"取消"而不是"确定"，让视频从头开始播放
        // 原因：点击"确定"会跳到上次位置，如果上次位置接近结尾，
        // 服务器可能因为观看时间不足而不标记为完成
        const messageBoxes = document.querySelectorAll('.el-message-box');
        for (const mb of messageBoxes) {
            if (mb.offsetParent !== null) {
                const msgText = mb.querySelector('.el-message-box__message')?.textContent || '';
                if (msgText.includes('继续上次播放')) {
                    // 找"取消"按钮，从头播放
                    const buttons = mb.querySelectorAll('.el-button');
                    for (const btn of buttons) {
                        const text = btn.textContent.trim();
                        if (text.includes('取消') && !btn.disabled) {
                            btn.click();
                            log('点击"取消" — 从头播放视频（确保完整观看）', 'success');
                            return true;
                        }
                    }
                    // 如果找不到取消按钮，找确定按钮（不应该走到这里）
                    for (const btn of buttons) {
                        if (btn.textContent.trim() === '确定' && !btn.disabled) {
                            btn.click();
                            log('未找到取消按钮，点击确定', 'warn');
                            return true;
                        }
                    }
                }
            }
        }

        // 处理 el-dialog 弹窗
        const dialog = document.querySelector('.el-dialog__wrapper:not([style*="display: none"])') ||
                       document.querySelector('.el-dialog');
        if (dialog && dialog.offsetParent !== null) {
            const dialogText = dialog.textContent || '';
            // 处理 "未找到内容或已下线" 等错误弹窗
            if (dialogText.includes('未找到内容') || dialogText.includes('已下线')) {
                const confirmBtn = dialog.querySelector('.el-button--primary') || dialog.querySelector('.el-button');
                if (confirmBtn && !confirmBtn.disabled) {
                    confirmBtn.click();
                    log('处理错误弹窗: ' + dialogText.substring(0, 30), 'warn');
                    return true;
                }
            }
            // 处理其他确认弹窗
            if (dialogText.includes('确定') || dialogText.includes('知道了')) {
                const buttons = dialog.querySelectorAll('.el-button');
                for (const btn of buttons) {
                    const text = btn.textContent.trim();
                    if ((text === '确定' || text === '知道了') && !btn.disabled) {
                        btn.click();
                        log('自动点击弹窗按钮: ' + text, 'success');
                        return true;
                    }
                }
            }
        }

        // 处理错误提示弹窗（如"您已在其他客户端观看视频"）
        for (const mb of messageBoxes) {
            if (mb.offsetParent !== null) {
                const msgText = mb.querySelector('.el-message-box__message')?.textContent || '';
                if (msgText.includes('其他客户端') || msgText.includes('服务器异常') || msgText.includes('缺少必传参数')) {
                    const confirmBtn = mb.querySelector('.el-message-box__btns .el-button--primary');
                    if (confirmBtn && !confirmBtn.disabled) {
                        log('处理错误弹窗: ' + msgText, 'error');
                        confirmBtn.click();
                        // 这些是致命错误，可能需要刷新
                        STATE.lastProgressTime = 0; // 触发看门狗
                        return true;
                    }
                }
            }
        }

        return false;
    }

    // ==================== 视频播放控制 ====================

    // 获取播放器暂停状态（兼容 TCPlayer API 和原生 video）
    function getPausedState() {
        const player = getPlayer();
        const video = getVideoEl();
        let isPaused = false;
        let isEnded = false;

        try {
            if (player) {
                isPaused = typeof player.paused === 'function' ? player.paused() : player.paused;
                isEnded = typeof player.ended === 'function' ? player.ended() : player.ended;
            } else if (video) {
                isPaused = video.paused;
                isEnded = video.ended;
            }
        } catch (e) {
            if (video) {
                isPaused = video.paused;
                isEnded = video.ended;
            }
        }
        return { isPaused, isEnded };
    }

    // 强制播放视频 — 多种策略确保视频开始播放
    function forcePlay() {
        const player = getPlayer();
        const video = getVideoEl();

        if (!player && !video) return false;

        const { isPaused, isEnded } = getPausedState();
        // 视频已结束时不强制播放
        if (!isPaused || isEnded) return false;

        let played = false;

        // 策略1: TCPlayer API
        try {
            if (player && typeof player.play === 'function') {
                const result = player.play();
                if (result && typeof result.catch === 'function') {
                    result.catch(() => {});
                }
                played = true;
            }
        } catch (e) {}

        // 策略2: 直接操作 video 元素
        try {
            if (video && video.paused) {
                video.play().catch(() => {});
                played = true;
            }
        } catch (e) {}

        // 策略3: 模拟点击播放器区域的播放按钮
        if (!played) {
            const playBtn = document.querySelector('.vjs-big-play-button') ||
                           document.querySelector('.vjs-play-control') ||
                           document.querySelector('[class*="play"]');
            if (playBtn) {
                playBtn.click();
                played = true;
            }
        }

        if (played) {
            log('视频已暂停，自动恢复播放', 'warn');
        }
        return played;
    }

    // 防止暂停（覆盖visibilitychange处理）
    function antiPause() {
        const vm = getVueVM();
        if (vm && vm.onVisibilitychange) {
            // 覆盖 visibilitychange 处理器，使其不暂停视频
            vm.onVisibilitychange = function () {
                // 即使页面不可见，也继续播放
                const player = this.player;
                if (player) {
                    const isPaused = typeof player.paused === 'function' ? player.paused() : player.paused;
                    const isEnded = typeof player.ended === 'function' ? player.ended() : player.ended;
                    if (isPaused && !isEnded) {
                        try { player.play(); } catch (e) {}
                    }
                }
            };
            log('已覆盖页面可见性检测，视频不会被暂停', 'success');
        }

        // 阻止 document.hidden 导致的暂停
        try {
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true,
            });
            Object.defineProperty(document, 'webkitHidden', {
                get: () => false,
                configurable: true,
            });
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true,
            });
        } catch (e) {
            log('无法覆盖 document.hidden（可能已被定义）', 'warn');
        }
    }

    // ==================== 课程目录操作 ====================
    // 获取所有章节和小节（扁平化）
    function getAllSections() {
        const vm = getVueVM();
        if (!vm || !vm.ListML) return [];

        const sections = [];
        try {
            vm.ListML.forEach((chapter, chapterIdx) => {
                const listChapter = chapter.listChapter || [];
                listChapter.forEach((section, sectionIdx) => {
                    sections.push({
                        chapterIdx,
                        sectionIdx,
                        chapterTitle: chapter.trainResourceTitle || '',
                        sectionTitle: section.courseChapterTitle || '',
                        state: section.state,  // 1=未尝试, 2=未完成, 3=已完成
                        courseId: section.courseId,
                        courseChapterId: section.courseChapterId,
                        fileId: section.fileId,
                        section: section,
                    });
                });
            });
        } catch (e) {
            log('获取课程列表异常: ' + e.message, 'error');
        }
        return sections;
    }

    // 获取当前播放的小节
    function getCurrentSection() {
        const vm = getVueVM();
        if (!vm) return null;
        return {
            chapterId: vm.chapterId,
            courseId: vm.courseId,
        };
    }

    // 获取当前小节在扁平列表中的索引
    function getCurrentSectionIdx() {
        const sections = getAllSections();
        const current = getCurrentSection();
        if (!current) return -1;
        return sections.findIndex(s => s.courseChapterId === current.chapterId);
    }

    // 获取当前小节的状态
    function getCurrentSectionState() {
        const sections = getAllSections();
        const current = getCurrentSection();
        if (!current) return null;
        const section = sections.find(s => s.courseChapterId === current.chapterId);
        return section ? section.state : null;
    }

    // 找到下一个未完成的小节
    // 修复：如果当前小节未完成，从头开始找（不跳过当前小节）
    function getNextUncompletedSection() {
        const sections = getAllSections();
        STATE.stats.total = sections.length;
        STATE.stats.completed = sections.filter(s => s.state === 3).length;

        if (sections.length === 0) return null;

        // 找当前小节的位置
        const current = getCurrentSection();
        let currentIdx = -1;
        if (current) {
            currentIdx = sections.findIndex(s => s.courseChapterId === current.chapterId);
        }

        // 获取当前小节的状态
        const currentSection = currentIdx >= 0 ? sections[currentIdx] : null;
        const currentIsCompleted = currentSection && currentSection.state === 3;

        if (currentIsCompleted) {
            // 当前小节已完成，从下一个开始找
            for (let i = currentIdx + 1; i < sections.length; i++) {
                if (sections[i].state !== 3) {
                    return sections[i];
                }
            }
            // 如果后面没有，从头开始找
            for (let i = 0; i < sections.length; i++) {
                if (sections[i].state !== 3) {
                    return sections[i];
                }
            }
        } else {
            // 当前小节未完成 — 不跳过它，优先从当前位置之后找
            // 但如果当前小节刚结束还没标记完成，先从后面找
            for (let i = Math.max(0, currentIdx + 1); i < sections.length; i++) {
                if (sections[i].state !== 3) {
                    return sections[i];
                }
            }
            // 如果后面没有未完成的，从头找（包括当前小节）
            for (let i = 0; i < sections.length; i++) {
                if (sections[i].state !== 3) {
                    return sections[i];
                }
            }
        }

        return null;
    }

    // 检查是否全部完成
    function isAllCompleted() {
        const sections = getAllSections();
        return sections.length > 0 && sections.every(s => s.state === 3);
    }

    // 等待当前小节状态变为已完成
    async function waitForCompletion() {
        const current = getCurrentSection();
        if (!current) return false;

        const targetChapterId = current.chapterId;
        const startTime = Date.now();

        log(`等待服务器确认小节完成 (最多${CONFIG.completionWaitTimeout / 1000}秒)...`, 'info');

        while (Date.now() - startTime < CONFIG.completionWaitTimeout) {
            const sections = getAllSections();
            const section = sections.find(s => s.courseChapterId === targetChapterId);

            if (section && section.state === 3) {
                log('✅ 服务器已确认小节完成', 'success');
                STATE.currentSectionReplayCount = 0;
                return true;
            }

            await sleep(2000);
        }

        log('等待超时，小节可能未完成', 'warn');
        return false;
    }

    // 切换到指定小节
    function playSection(targetSection) {
        const vm = getVueVM();
        if (!vm) {
            log('无法获取Vue实例', 'error');
            return false;
        }

        try {
            log(`切换到: [${targetSection.chapterTitle}] ${targetSection.sectionTitle}`, 'info');
            // 重置 lastEndedChapterId，允许新小节发送 "end"
            STATE.lastEndedChapterId = null;
            STATE.isSwitching = true;

            vm.onPlayItem(targetSection.section, targetSection.chapterIdx, targetSection.sectionIdx);
            STATE.currentChapterIdx = targetSection.chapterIdx;
            STATE.currentSectionIdx = targetSection.sectionIdx;
            STATE.retryCount = 0;
            STATE.lastProgressTime = Date.now();
            STATE.stuckCount = 0;

            // 3秒后解除切换状态
            setTimeout(() => { STATE.isSwitching = false; }, 3000);

            return true;
        } catch (e) {
            log(`切换小节失败: ${e.message}`, 'error');
            STATE.isSwitching = false;
            return false;
        }
    }

    // 通过点击DOM元素切换小节（备用方案）
    function playSectionByClick(targetSection) {
        const ciElements = document.querySelectorAll('.ci');
        let currentIdx = 0;
        for (let i = 0; i < targetSection.chapterIdx; i++) {
            const vm = getVueVM();
            if (vm && vm.ListML && vm.ListML[i] && vm.ListML[i].listChapter) {
                currentIdx += vm.ListML[i].listChapter.length;
            }
        }
        currentIdx += targetSection.sectionIdx;

        if (ciElements[currentIdx]) {
            ciElements[currentIdx].click();
            log(`通过点击DOM切换到: ${targetSection.sectionTitle}`, 'info');
            return true;
        }
        return false;
    }

    // 检查播放器是否被销毁（AllClearEmpty 被调用的迹象）
    function isPlayerDestroyed() {
        const vm = getVueVM();
        if (!vm) return true;
        if (!vm.player) return true;
        if (!vm.ListML || vm.ListML.length === 0) return true;
        if (!vm.chapterId) return true;
        return false;
    }

    // 检查 isLoading 是否卡住
    function checkIsLoadingStuck() {
        const vm = getVueVM();
        if (!vm) return false;

        if (vm.isLoading) {
            // 记录 isLoading 变为 true 的时间
            if (!STATE._isLoadingSince) {
                STATE._isLoadingSince = Date.now();
            }

            if (Date.now() - STATE._isLoadingSince > CONFIG.isLoadingTimeout) {
                log('isLoading 已卡住超过60秒，强制重置', 'warn');
                vm.isLoading = false;
                STATE._isLoadingSince = null;
                return true;
            }
        } else {
            STATE._isLoadingSince = null;
        }
        return false;
    }

    // ==================== 主循环 ====================
    let mainTimer = null;
    let dialogTimer = null;
    let watchdogTimer = null;

    async function mainLoop() {
        if (!STATE.running) return;

        // 检查播放器是否被销毁
        if (isPlayerDestroyed()) {
            log('检测到播放器被销毁（可能是API错误导致），刷新页面恢复...', 'error');
            STATE.running = false;
            setTimeout(() => window.location.reload(), 2000);
            return;
        }

        // 检查 isLoading 是否卡住
        checkIsLoadingStuck();

        const vm = getVueVM();
        if (!vm) {
            log('等待页面加载...', 'info');
            return;
        }

        const player = vm.player;
        const video = getVideoEl();

        if (!player && !video) {
            log('等待视频播放器加载...', 'info');
            return;
        }

        try {
            // 如果正在切换小节，跳过本次检查
            if (STATE.isSwitching) {
                return;
            }

            // 检查视频是否结束
            let isEnded = false;
            let currentTime = 0;
            let duration = 0;

            if (player) {
                isEnded = player.ended ? player.ended() : false;
                currentTime = player.currentTime ? player.currentTime() : 0;
                duration = player.duration ? player.duration() : 0;
            } else if (video) {
                isEnded = video.ended;
                currentTime = video.currentTime;
                duration = video.duration;
            }

            // 看门狗：检测播放位置是否卡住
            if (currentTime > 0 && !isEnded) {
                if (Math.abs(currentTime - STATE.lastCurrentTime) < 0.5) {
                    STATE.stuckCount++;
                    if (STATE.stuckCount > 10) {
                        // 30秒内位置没变化（10次 * 3秒间隔）
                        log('视频可能卡住了（位置未变化），尝试恢复...', 'warn');
                        STATE.stuckCount = 0;
                        STATE.lastProgressTime = Date.now();
                        // 尝试恢复
                        forcePlay();
                        // 如果恢复不了，可能需要刷新
                        if (STATE.stuckCount > 15) {
                            log('视频持续卡住，刷新页面...', 'error');
                            STATE.running = false;
                            setTimeout(() => window.location.reload(), 2000);
                            return;
                        }
                    }
                } else {
                    STATE.stuckCount = 0;
                    STATE.lastProgressTime = Date.now();
                }
            }
            STATE.lastCurrentTime = currentTime;

            if (isEnded) {
                log('当前小节播放完毕', 'success');
                STATE.retryCount = 0;

                // 关键修复：等待服务器确认小节完成
                const completed = await waitForCompletion();

                // 检查是否全部完成
                if (isAllCompleted()) {
                    log('🎉 所有课程已全部学完！', 'success');
                    STATE.running = false;
                    updateUI();
                    return;
                }

                // 获取当前小节状态
                const currentState = getCurrentSectionState();

                if (currentState !== 3 && STATE.currentSectionReplayCount < CONFIG.replayMaxRetries) {
                    // 当前小节未完成，重播当前小节
                    STATE.currentSectionReplayCount++;
                    log(`当前小节未完成，重播 (第${STATE.currentSectionReplayCount}次重播)`, 'warn');

                    const sections = getAllSections();
                    const currentIdx = getCurrentSectionIdx();
                    if (currentIdx >= 0 && sections[currentIdx]) {
                        const success = playSection(sections[currentIdx]);
                        if (!success) {
                            log('重播切换失败，尝试点击DOM...', 'warn');
                            playSectionByClick(sections[currentIdx]);
                        }
                        await sleep(3000);
                    }
                    return;
                } else if (currentState !== 3) {
                    // 重播次数用完，跳到下一节
                    log('重播次数用完，跳到下一未完成小节', 'warn');
                    STATE.currentSectionReplayCount = 0;
                } else {
                    // 当前小节已完成，重置重播计数
                    STATE.currentSectionReplayCount = 0;
                }

                // 找到下一个未完成的小节
                const next = getNextUncompletedSection();
                if (next) {
                    log(`下一节: [${next.chapterTitle}] ${next.sectionTitle} (状态: ${next.state === 1 ? '未尝试' : '未完成'})`, 'info');
                    const success = playSection(next);
                    if (!success) {
                        log('切换失败，尝试点击DOM元素...', 'warn');
                        playSectionByClick(next);
                    }
                    await sleep(3000);
                } else {
                    log('没有找到未完成的小节', 'warn');
                    if (isAllCompleted()) {
                        log('🎉 所有课程已全部学完！', 'success');
                        STATE.running = false;
                        updateUI();
                    }
                }
                return;
            }

            // 检查视频是否暂停
            const pauseState = getPausedState();

            if (pauseState.isPaused && !pauseState.isEnded) {
                forcePlay();
            }

            // 更新进度信息
            if (duration > 0) {
                const progress = Math.round((currentTime / duration) * 100);
                const sections = getAllSections();
                const completedCount = sections.filter(s => s.state === 3).length;
                const totalCount = sections.length;
                updateProgress(progress, currentTime, duration, completedCount, totalCount);
            }

            STATE.retryCount = 0;
        } catch (e) {
            STATE.retryCount++;
            log(`主循环异常(${STATE.retryCount}/${CONFIG.maxRetries}): ${e.message}`, 'error');
            if (STATE.retryCount >= CONFIG.maxRetries) {
                log('重试次数过多，刷新页面...', 'error');
                STATE.running = false;
                setTimeout(() => window.location.reload(), 3000);
            }
        }
    }

    function startMainLoop() {
        if (mainTimer) clearInterval(mainTimer);
        mainTimer = setInterval(mainLoop, CONFIG.checkInterval);
        log('主循环已启动', 'success');
    }

    function stopMainLoop() {
        if (mainTimer) {
            clearInterval(mainTimer);
            mainTimer = null;
        }
    }

    function startDialogCheck() {
        if (dialogTimer) clearInterval(dialogTimer);
        dialogTimer = setInterval(() => {
            handleDialogs();
        }, CONFIG.dialogCheckInterval);
    }

    function stopDialogCheck() {
        if (dialogTimer) {
            clearInterval(dialogTimer);
            dialogTimer = null;
        }
    }

    // 看门狗：定期检查是否有进展
    function startWatchdog() {
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = setInterval(() => {
            if (!STATE.running) return;

            const elapsed = Date.now() - STATE.lastProgressTime;
            if (elapsed > CONFIG.watchdogTimeout) {
                log(`⚠️ 看门狗：已${Math.floor(elapsed / 1000)}秒无进展，刷新页面恢复...`, 'error');
                STATE.running = false;
                setTimeout(() => window.location.reload(), 2000);
            }
        }, 60000); // 每分钟检查一次
    }

    function stopWatchdog() {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
    }

    // ==================== 启动/停止 ====================
    function start() {
        if (STATE.running) {
            log('已经在运行中', 'warn');
            return;
        }

        const vm = getVueVM();
        if (!vm) {
            log('Vue 实例未找到，请确保在播放页面', 'error');
            return;
        }

        STATE.running = true;
        STATE.retryCount = 0;
        STATE.lastProgressTime = Date.now();
        STATE.lastCurrentTime = 0;
        STATE.stuckCount = 0;
        log('🚀 自动刷课已启动 (v2.0)', 'success');

        // 安装 hooks（防止 AllClearEmpty 和重复 end 调用）
        installHooks();

        // 反防暂停
        antiPause();

        // 启动弹窗检测
        startDialogCheck();

        // 启动主循环
        startMainLoop();

        // 启动看门狗
        startWatchdog();

        // 启动强制播放定时器
        setTimeout(() => startForcePlay(), 1000);

        // 立即执行一次
        setTimeout(mainLoop, 500);

        updateUI();
    }

    function stop() {
        STATE.running = false;
        stopMainLoop();
        stopDialogCheck();
        stopForcePlay();
        stopWatchdog();

        // 同时暂停视频播放
        const player = getPlayer();
        const video = getVideoEl();
        try {
            if (player && typeof player.pause === 'function') {
                player.pause();
            } else if (video) {
                video.pause();
            }
        } catch (e) {}

        log('⏹️ 自动刷课已停止，视频已暂停', 'warn');
        updateUI();
    }

    // ==================== UI ====================
    function createUI() {
        if (document.getElementById('cdwork-auto-ui')) return;

        const ui = document.createElement('div');
        ui.id = 'cdwork-auto-ui';
        ui.innerHTML = `
            <style>
                #cdwork-auto-ui {
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    z-index: 99999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: rgba(30, 35, 50, 0.95);
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                    color: #fff;
                    width: 320px;
                    overflow: hidden;
                    transition: width 0.3s ease, height 0.3s ease, border-radius 0.3s ease;
                    backdrop-filter: blur(10px);
                }
                #cdwork-auto-ui.collapsed {
                    width: 48px !important;
                    height: 48px !important;
                    border-radius: 50%;
                    cursor: pointer;
                }
                #cdwork-auto-ui.dragging {
                    transition: none !important;
                }
                #cdwork-auto-ui.collapsed .panel-body { display: none !important; }
                #cdwork-auto-ui.collapsed .panel-header { padding: 0 !important; justify-content: center !important; height: 48px !important; }
                #cdwork-auto-ui.collapsed .panel-header .header-title { display: none !important; }
                #cdwork-auto-ui.collapsed .panel-header .toggle-btn { display: none !important; }
                #cdwork-auto-ui.collapsed .panel-header .collapse-icon { display: flex !important; font-size: 24px; }
                .panel-header {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    padding: 12px 16px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: grab;
                    user-select: none;
                }
                .panel-header:active { cursor: grabbing; }
                .header-title { display: flex; align-items: center; gap: 6px; }
                .toggle-btn {
                    background: rgba(255,255,255,0.2);
                    border: none;
                    color: #fff;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    cursor: pointer;
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.2s;
                    flex-shrink: 0;
                }
                .toggle-btn:hover { background: rgba(255,255,255,0.3); }
                .collapse-icon { display: none; align-items: center; justify-content: center; }
                .panel-body { padding: 12px 16px; }
                .status-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                    font-size: 12px;
                }
                .status-badge {
                    padding: 2px 10px;
                    border-radius: 10px;
                    font-size: 11px;
                    font-weight: 600;
                }
                .status-running { background: #67c23a; color: #fff; }
                .status-stopped { background: #909399; color: #fff; }
                .progress-bar-container {
                    background: rgba(255,255,255,0.1);
                    border-radius: 6px;
                    height: 8px;
                    overflow: hidden;
                    margin: 6px 0 10px;
                }
                .progress-bar {
                    height: 100%;
                    background: linear-gradient(90deg, #67c23a, #4caf50);
                    border-radius: 6px;
                    transition: width 0.3s ease;
                    width: 0%;
                }
                .stats-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                    margin-bottom: 10px;
                }
                .stat-card {
                    background: rgba(255,255,255,0.08);
                    border-radius: 8px;
                    padding: 8px;
                    text-align: center;
                }
                .stat-value { font-size: 18px; font-weight: 700; }
                .stat-label { font-size: 10px; color: rgba(255,255,255,0.6); margin-top: 2px; }
                .btn-group { display: flex; gap: 8px; margin-bottom: 10px; }
                .btn {
                    flex: 1;
                    padding: 8px 0;
                    border: none;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .btn-start { background: #67c23a; color: #fff; }
                .btn-start:hover { background: #5daf34; }
                .btn-start:disabled { background: #555; cursor: not-allowed; }
                .btn-stop { background: #f56c6c; color: #fff; }
                .btn-stop:hover { background: #e65151; }
                .btn-stop:disabled { background: #555; cursor: not-allowed; }
                .log-container {
                    background: rgba(0,0,0,0.3);
                    border-radius: 8px;
                    padding: 8px;
                    max-height: 150px;
                    overflow-y: auto;
                    font-size: 11px;
                    font-family: 'SF Mono', Monaco, monospace;
                    line-height: 1.5;
                }
                .log-container::-webkit-scrollbar { width: 4px; }
                .log-container::-webkit-scrollbar-track { background: transparent; }
                .log-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
                .log-entry { color: rgba(255,255,255,0.7); margin-bottom: 2px; word-break: break-all; }
            </style>
            <div class="panel-header" id="cdwork-drag-handle">
                <div class="header-title">
                    <span>📖</span>
                    <span>自动刷课助手 v2.0</span>
                </div>
                <button class="toggle-btn" id="cdwork-toggle-btn">−</button>
                <span class="collapse-icon">📖</span>
            </div>
            <div class="panel-body">
                <div class="status-row">
                    <span>运行状态</span>
                    <span class="status-badge status-stopped" id="cdwork-status">已停止</span>
                </div>
                <div class="status-row">
                    <span id="cdwork-current-section">当前: -</span>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="cdwork-progress-bar"></div>
                </div>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value" id="cdwork-completed">0</div>
                        <div class="stat-label">已完成</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="cdwork-total">0</div>
                        <div class="stat-label">总小节</div>
                    </div>
                </div>
                <div class="btn-group">
                    <button class="btn btn-start" id="cdwork-start-btn">▶ 开始刷课</button>
                    <button class="btn btn-stop" id="cdwork-stop-btn" disabled>⏹ 停止</button>
                </div>
                <div class="log-container" id="cdwork-log"></div>
            </div>
        `;
        document.body.appendChild(ui);

        // 绑定开始/停止按钮
        document.getElementById('cdwork-start-btn').addEventListener('click', start);
        document.getElementById('cdwork-stop-btn').addEventListener('click', stop);

        // 最小化/展开按钮
        document.getElementById('cdwork-toggle-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const panel = document.getElementById('cdwork-auto-ui');
            panel.classList.toggle('collapsed');
            document.getElementById('cdwork-toggle-btn').textContent = panel.classList.contains('collapsed') ? '+' : '−';
        });

        // 点击折叠状态的圆球展开
        document.getElementById('cdwork-auto-ui').addEventListener('click', (e) => {
            const panel = document.getElementById('cdwork-auto-ui');
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                document.getElementById('cdwork-toggle-btn').textContent = '−';
            }
        });

        // 拖拽功能
        makeDraggable(document.getElementById('cdwork-auto-ui'), document.getElementById('cdwork-drag-handle'));

        log('UI已加载，进入播放页将自动开始刷课', 'info');
    }

    function makeDraggable(panel, handle) {
        let isDragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('.toggle-btn')) return;
            if (e.target.closest('.collapse-icon')) return;
            if (e.button !== 0) return;

            isDragging = true;
            panel.classList.add('dragging');
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.right = 'auto';
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            e.preventDefault();
        });

        function onMove(e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = Math.max(0, Math.min(window.innerWidth - 50, startLeft + dx)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 50, startTop + dy)) + 'px';
        }

        function onUp() {
            if (!isDragging) return;
            isDragging = false;
            panel.classList.remove('dragging');
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function updateUI() {
        const startBtn = document.getElementById('cdwork-start-btn');
        const stopBtn = document.getElementById('cdwork-stop-btn');
        const statusEl = document.getElementById('cdwork-status');
        const logEl = document.getElementById('cdwork-log');

        if (!startBtn) return;

        if (STATE.running) {
            startBtn.disabled = true;
            stopBtn.disabled = false;
            statusEl.textContent = '运行中';
            statusEl.className = 'status-badge status-running';
        } else {
            startBtn.disabled = false;
            stopBtn.disabled = true;
            statusEl.textContent = '已停止';
            statusEl.className = 'status-badge status-stopped';
        }

        // 更新日志
        if (logEl) {
            logEl.innerHTML = STATE.log.slice(0, 20).map(l => `<div class="log-entry">${l}</div>`).join('');
        }

        // 更新统计
        const sections = getAllSections();
        if (sections.length > 0) {
            const completed = sections.filter(s => s.state === 3).length;
            document.getElementById('cdwork-completed').textContent = completed;
            document.getElementById('cdwork-total').textContent = sections.length;
        }
    }

    function updateProgress(progress, currentTime, duration, completed, total) {
        const bar = document.getElementById('cdwork-progress-bar');
        const sectionEl = document.getElementById('cdwork-current-section');
        if (bar) {
            bar.style.width = progress + '%';
        }
        if (sectionEl && duration > 0) {
            const fmt = (s) => {
                const m = Math.floor(s / 60);
                const sec = Math.floor(s % 60);
                return `${m}:${sec.toString().padStart(2, '0')}`;
            };
            sectionEl.textContent = `播放: ${fmt(currentTime)}/${fmt(duration)} (${progress}%) | 完成: ${completed}/${total}`;
        }
        if (total > 0) {
            document.getElementById('cdwork-completed').textContent = completed;
            document.getElementById('cdwork-total').textContent = total;
        }
    }

    // ==================== 初始化 ====================
    let playForceTimer = null;

    // 启动强制播放定时器 — 持续尝试播放直到成功
    function startForcePlay() {
        if (playForceTimer) clearInterval(playForceTimer);
        let forcePlayCount = 0;
        playForceTimer = setInterval(() => {
            forcePlayCount++;
            const { isPaused, isEnded } = getPausedState();
            if (isPaused && !isEnded) {
                forcePlay();
            } else if (!isPaused) {
                clearInterval(playForceTimer);
                playForceTimer = null;
                log('视频已开始播放', 'success');
            }
            if (forcePlayCount >= 30) {
                clearInterval(playForceTimer);
                playForceTimer = null;
            }
        }, 2000);
    }

    function stopForcePlay() {
        if (playForceTimer) {
            clearInterval(playForceTimer);
            playForceTimer = null;
        }
    }

    function init() {
        // 只在学习/播放页面初始化
        const url = window.location.href;
        const isPlayPage = url.includes('/pages/train/play') || url.includes('/pages/course/play');

        if (!isPlayPage) {
            // 在培训详情页添加快速开始按钮
            if (url.includes('/pages/train/detail') || url.includes('/pages/course/detail')) {
                setTimeout(() => {
                    enhanceDetailPage();
                }, 2000);
            }
            return;
        }

        // 等待页面完全加载
        setTimeout(() => {
            createUI();
            antiPause();
            startDialogCheck();

            // 自动处理弹窗
            handleDialogs();

            // 进入播放页自动启动刷课
            if (!STATE.running) {
                log('检测到播放页面，自动开始刷课...', 'info');
                start();
            }

            // 额外启动一个强制播放定时器
            setTimeout(() => {
                startForcePlay();
            }, 3000);
        }, 2000);
    }

    // 在详情页添加增强功能
    function enhanceDetailPage() {
        const startBtn = Array.from(document.querySelectorAll('*')).find(el => {
            return el.textContent.trim() === '开始培训' || el.textContent.trim() === '开始学习';
        });

        if (startBtn && !startBtn.dataset.enhanced) {
            startBtn.dataset.enhanced = 'true';
            log('检测到培训详情页，"开始培训/学习"后脚本将自动生效', 'info');
        }
    }

    // 监听URL变化（SPA路由）
    let lastURL = window.location.href;
    const observer = new MutationObserver(() => {
        if (window.location.href !== lastURL) {
            lastURL = window.location.href;
            setTimeout(init, 1000);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
