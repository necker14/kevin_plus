// ==UserScript==
// @name         成都职业培训网络学院 - 全自动刷课脚本
// @namespace    https://www.cdwork.cn/
// @version      1.5
// @description  自动播放视频、自动跳转下一节，直到所有培训课程全部学完。进入播放页自动启动。
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
        checkInterval: 2000,       // 主循环检测间隔(ms)
        replayRetryDelay: 3000,    // 播放重试延迟(ms)
        nextSectionDelay: 2000,    // 切换下一节延迟(ms)
        dialogCheckInterval: 1000, // 弹窗检测间隔(ms)
        maxRetries: 5,             // 最大重试次数
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

    // ==================== 弹窗处理 ====================
    function handleDialogs() {
        // 处理"是否继续上次播放"弹窗
        const dialog = document.querySelector('.el-dialog__wrapper:not([style*="display: none"])') ||
                       document.querySelector('.el-dialog');
        if (dialog && dialog.offsetParent !== null) {
            const dialogText = dialog.textContent || '';
            if (dialogText.includes('继续上次播放') || dialogText.includes('确定')) {
                // 优先找"确定"按钮
                const buttons = dialog.querySelectorAll('.el-button');
                for (const btn of buttons) {
                    if (btn.textContent.trim() === '确定' && !btn.disabled) {
                        btn.click();
                        log('自动点击"确定"按钮（继续上次播放）', 'success');
                        return true;
                    }
                }
                // 如果没有"确定"，找非"取消"的按钮
                for (const btn of buttons) {
                    const text = btn.textContent.trim();
                    if (!text.includes('取消') && !btn.disabled) {
                        btn.click();
                        log(`自动点击弹窗按钮: ${text}`, 'success');
                        return true;
                    }
                }
            }
        }

        // 处理其他可能的弹窗（如错误提示）
        const messageBoxes = document.querySelectorAll('.el-message-box');
        for (const mb of messageBoxes) {
            if (mb.offsetParent !== null) {
                const confirmBtn = mb.querySelector('.el-message-box__btns .el-button--primary');
                if (confirmBtn && !confirmBtn.disabled) {
                    const msgText = mb.querySelector('.el-message-box__message')?.textContent || '';
                    log(`处理弹窗: ${msgText}`, 'warn');
                    confirmBtn.click();
                    return true;
                }
            }
        }

        return false;
    }

    // ==================== 视频播放控制 ====================
    function ensurePlaying() {
        const player = getPlayer();
        const video = getVideoEl();

        if (!player && !video) return false;

        try {
            if (player) {
                if (player.paused && !player.ended()) {
                    player.play();
                    log('视频已暂停，自动恢复播放', 'warn');
                    return true;
                }
            } else if (video) {
                if (video.paused && !video.ended) {
                    video.play().catch(() => {});
                    log('视频已暂停，自动恢复播放', 'warn');
                    return true;
                }
            }
        } catch (e) {
            // 忽略
        }
        return false;
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
                    if (player.paused && !player.ended()) {
                        try { player.play(); } catch (e) {}
                    }
                }
            };
            log('已覆盖页面可见性检测，视频不会被暂停', 'success');
        }

        // 阻止 document.hidden 导致的暂停
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
    }

    // ==================== 课程目录操作 ====================
    // 获取所有章节和小节（扁平化）
    function getAllSections() {
        const vm = getVueVM();
        if (!vm || !vm.ListML) return [];

        const sections = [];
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

    // 找到下一个未完成的小节
    function getNextUncompletedSection() {
        const sections = getAllSections();
        STATE.stats.total = sections.length;
        STATE.stats.completed = sections.filter(s => s.state === 3).length;

        // 找当前小节的位置
        const current = getCurrentSection();
        let currentIdx = -1;
        if (current) {
            currentIdx = sections.findIndex(s => s.courseChapterId === current.chapterId);
        }

        // 从当前位置之后开始找未完成的小节
        for (let i = Math.max(0, currentIdx + 1); i < sections.length; i++) {
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

        return null;
    }

    // 检查是否全部完成
    function isAllCompleted() {
        const sections = getAllSections();
        return sections.length > 0 && sections.every(s => s.state === 3);
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
            vm.onPlayItem(targetSection.section, targetSection.chapterIdx, targetSection.sectionIdx);
            STATE.currentChapterIdx = targetSection.chapterIdx;
            STATE.currentSectionIdx = targetSection.sectionIdx;
            STATE.retryCount = 0;
            return true;
        } catch (e) {
            log(`切换小节失败: ${e.message}`, 'error');
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

    // ==================== 主循环 ====================
    let mainTimer = null;
    let dialogTimer = null;

    async function mainLoop() {
        if (!STATE.running) return;

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

            if (isEnded) {
                log('当前小节播放完毕，准备切换下一节...', 'success');
                STATE.retryCount = 0;

                // 等待一下让服务器处理完成
                await sleep(CONFIG.nextSectionDelay);

                // 检查是否全部完成
                if (isAllCompleted()) {
                    log('🎉 所有课程已全部学完！', 'success');
                    STATE.running = false;
                    updateUI();
                    return;
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
                    await sleep(2000);
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
            let isPaused = false;
            if (player) {
                isPaused = player.paused ? player.paused() : false;
            } else if (video) {
                isPaused = video.paused;
            }

            if (isPaused && !isEnded) {
                ensurePlaying();
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
                log('重试次数过多，尝试刷新页面...', 'error');
                STATE.retryCount = 0;
                // 不自动刷新，避免死循环
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

    // ==================== 启动/停止 ====================
    function start() {
        if (STATE.running) {
            log('已经在运行中', 'warn');
            return;
        }
        STATE.running = true;
        STATE.retryCount = 0;
        log('🚀 自动刷课已启动', 'success');

        // 反防暂停
        antiPause();

        // 启动弹窗检测
        startDialogCheck();

        // 启动主循环
        startMainLoop();

        // 立即执行一次
        setTimeout(mainLoop, 500);

        updateUI();
    }

    function stop() {
        STATE.running = false;
        stopMainLoop();
        stopDialogCheck();
        log('⏹️ 自动刷课已停止', 'warn');
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
                    transition: all 0.3s ease;
                    backdrop-filter: blur(10px);
                }
                #cdwork-auto-ui.collapsed {
                    width: 48px !important;
                    height: 48px !important;
                    border-radius: 50%;
                    cursor: pointer;
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
                    <span>自动刷课助手</span>
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

        // 最小化/展开按钮 — 必须 stopPropagation 防止冒泡到 panel 的 click
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

        // 拖拽功能 — 直接对 #cdwork-auto-ui 操作
        makeDraggable(document.getElementById('cdwork-auto-ui'), document.getElementById('cdwork-drag-handle'));

        log('UI已加载，进入播放页将自动开始刷课', 'info');
    }

    function makeDraggable(panel, handle) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            // 点击按钮时不触发拖拽
            if (e.target.closest('.toggle-btn')) return;
            if (e.target.closest('.collapse-icon')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            // 切换为 left/top 定位，清除 right
            panel.style.right = 'auto';
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = Math.max(0, Math.min(window.innerWidth - 50, startLeft + dx)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 50, startTop + dy)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
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

            // 自动处理弹窗并尝试开始播放
            setTimeout(() => {
                handleDialogs();
                const vm = getVueVM();
                if (vm && vm.player) {
                    // 尝试自动播放
                    const player = vm.player;
                    try {
                        if (player.paused && player.paused()) {
                            player.play();
                        }
                    } catch (e) {}

                    // 进入播放页自动启动刷课，无需手动点击
                    if (!STATE.running) {
                        log('检测到播放页面，3秒后自动开始刷课...', 'info');
                        setTimeout(() => {
                            if (!STATE.running) start();
                        }, 3000);
                    }
                }
            }, 2000);
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
