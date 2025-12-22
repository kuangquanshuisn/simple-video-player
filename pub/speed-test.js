// ========== 渠道下载速度测试模块 ==========
// 独立的测速模块，通过 window.SpeedTest 暴露API

(function() {
  'use strict';

  // 常量配置
  const SPEED_STORAGE_KEY = 'channelSpeedData';
  const SPEED_UPDATE_INTERVAL = 10 * 60 * 1000; // 10分钟
  const TEST_TIMEOUT = 15000; // 15秒超时
  const TEST_DELAY = 2000; // 每次测速间隔2秒
  const INITIAL_DELAY = 5000; // 首次测速延迟5秒

  // 私有变量
  let speedTestTimer = null;
  let updateCallback = null;
  let getSeriesDataFunc = null;
  let getCurrentEpisodeIndexFunc = null;
  let getCurrentSeriesIndexFunc = null;  // 新增：获取当前电视剧索引的函数

  // ========== 数据管理函数 ==========

  // 加载速度数据
  function loadSpeedData() {
    try {
      const data = localStorage.getItem(SPEED_STORAGE_KEY);
      return data ? JSON.parse(data) : { channelSpeeds: {}, lastUpdateTime: 0 };
    } catch (e) {
      console.error('加载速度数据失败:', e);
      return { channelSpeeds: {}, lastUpdateTime: 0 };
    }
  }

  // 保存速度数据
  function saveSpeedData(data) {
    try {
      localStorage.setItem(SPEED_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('保存速度数据失败:', e);
    }
  }

  // 获取特定渠道的速度
  function getChannelSpeed(seriesTitle, channelName) {
    const data = loadSpeedData();
    return data.channelSpeeds[seriesTitle]?.[channelName] || null;
  }

  // 清除特定渠道的速度数据
  function clearChannelSpeed(seriesTitle, channelName) {
    const data = loadSpeedData();
    if (data.channelSpeeds[seriesTitle]) {
      delete data.channelSpeeds[seriesTitle][channelName];
    }
    saveSpeedData(data);
  }

  // 保存特定渠道的速度
  function saveChannelSpeed(seriesTitle, channelName, speed, episodeIndex, channelIndex) {
    const data = loadSpeedData();

    if (!data.channelSpeeds[seriesTitle]) {
      data.channelSpeeds[seriesTitle] = {};
    }

    data.channelSpeeds[seriesTitle][channelName] = {
      speed: speed,
      timestamp: Date.now(),
      episodeIndex: episodeIndex,
      channelIndex: channelIndex
    };

    data.lastUpdateTime = Date.now();
    saveSpeedData(data);
  }

  // ========== M3U8解析和测速函数 ==========

  // 解析M3U8文件，提取.ts片段URL
  function parseM3U8(m3u8Content, baseUrl) {
    const lines = m3u8Content.split('\n');
    const tsUrls = [];

    for (let line of lines) {
      line = line.trim();
      // 跳过注释和空行
      if (line && !line.startsWith('#')) {
        try {
          const tsUrl = line.startsWith('http')
            ? line
            : new URL(line, baseUrl).href;
          tsUrls.push(tsUrl);
        } catch (e) {
          console.warn('解析URL失败:', line);
        }
      }
    }

    return tsUrls;
  }

  // 测量单个渠道速度
  async function measureChannelSpeed(m3u8Url, timeout = TEST_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // 步骤1: 获取m3u8文件
      const m3u8Response = await fetch(m3u8Url, {
        signal: controller.signal
      });

      if (!m3u8Response.ok) {
        throw new Error(`HTTP ${m3u8Response.status}`);
      }

      const m3u8Text = await m3u8Response.text();

      // 步骤2: 解析.ts片段URL
      const tsUrls = parseM3U8(m3u8Text, m3u8Url);

      if (tsUrls.length === 0) {
        console.warn('未找到视频片段:', m3u8Url);
        return null;
      }

      // 步骤3: 下载第一个.ts片段测速
      const tsUrl = tsUrls[0];
      const startTime = performance.now();

      const tsResponse = await fetch(tsUrl, {
        signal: controller.signal
      });

      if (!tsResponse.ok) {
        throw new Error(`TS HTTP ${tsResponse.status}`);
      }

      const blob = await tsResponse.blob();
      const endTime = performance.now();

      // 步骤4: 计算速度
      const durationSeconds = (endTime - startTime) / 1000;
      const sizeBytes = blob.size;
      const speedKBps = (sizeBytes / 1024) / durationSeconds;

      console.log(`测速成功: ${m3u8Url} - ${Math.round(speedKBps)} KB/s`);
      return Math.round(speedKBps);

    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('测速超时:', m3u8Url);
      } else {
        console.warn('测速失败:', m3u8Url, error.message);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ========== 批量测速和调度器 ==========

  // 延迟函数
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 测试所有渠道速度
  async function testAllChannelSpeeds(force = false) {
    if (!getSeriesDataFunc || !getCurrentEpisodeIndexFunc || !getCurrentSeriesIndexFunc) {
      console.error('未设置数据获取函数');
      return;
    }

    const seriesData = getSeriesDataFunc();
    const currentEpisodeIndex = getCurrentEpisodeIndexFunc();
    const currentSeriesIndex = getCurrentSeriesIndexFunc();

    // 边界检查：确保当前电视剧索引有效
    if (currentSeriesIndex < 0 || currentSeriesIndex >= seriesData.length) {
      console.error('当前电视剧索引无效:', currentSeriesIndex);
      return;
    }

    const currentSeries = seriesData[currentSeriesIndex];

    // 边界检查：确保当前电视剧有渠道
    if (!currentSeries.channels || currentSeries.channels.length === 0) {
      console.warn('当前电视剧没有可用渠道');
      return;
    }

    // 如果是强制测速，先清除当前电视剧的所有渠道缓存数据
    if (force) {
      console.log('强制测速：清除当前电视剧的所有渠道缓存...');
      for (let channelIdx = 0; channelIdx < currentSeries.channels.length; channelIdx++) {
        const channel = currentSeries.channels[channelIdx];
        clearChannelSpeed(currentSeries.title, channel.name);
      }
      // 立即更新UI显示"测速中..."
      if (updateCallback && typeof updateCallback === 'function') {
        updateCallback();
      }
    }

    console.log(`开始测速 [${currentSeries.title}] 第${currentEpisodeIndex + 1}集...`);
    const startTime = Date.now();
    let testedCount = 0;
    let successCount = 0;

    // 只遍历当前电视剧的渠道
    for (let channelIdx = 0; channelIdx < currentSeries.channels.length; channelIdx++) {
      const channel = currentSeries.channels[channelIdx];

      // 检查是否需要更新
      const lastSpeed = getChannelSpeed(currentSeries.title, channel.name);
      const now = Date.now();

      if (force || !lastSpeed || (now - lastSpeed.timestamp) > SPEED_UPDATE_INTERVAL) {
        // 使用当前正在播放的集数
        const episodeIdx = currentEpisodeIndex;

        // 边界检查：确保当前集数在该渠道中存在
        if (channel.episodes && channel.episodes[episodeIdx]) {
          testedCount++;
          console.log(`测速 [${testedCount}]: ${currentSeries.title} - ${channel.name} - 第${episodeIdx + 1}集`);

          const speed = await measureChannelSpeed(channel.episodes[episodeIdx].url);

          if (speed !== null) {
            saveChannelSpeed(currentSeries.title, channel.name, speed, episodeIdx, channelIdx);
            successCount++;
          } else {
            // 保存失败状态为 0
            saveChannelSpeed(currentSeries.title, channel.name, 0, episodeIdx, channelIdx);
          }

          // 每次测速后延迟，避免过载
          await sleep(TEST_DELAY);
        } else {
          console.warn(`渠道 ${channel.name} 没有第${episodeIdx + 1}集，跳过测速`);
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`测速完成: 测试${testedCount}个，成功${successCount}个，耗时${duration}秒`);

    // 更新UI
    if (updateCallback && typeof updateCallback === 'function') {
      updateCallback();
    }
  }

  // 启动定时测速
  function startSpeedTestScheduler(getSeriesData, getCurrentEpisodeIndex, getCurrentSeriesIndex) {
    // 保存数据获取函数
    getSeriesDataFunc = getSeriesData;
    getCurrentEpisodeIndexFunc = getCurrentEpisodeIndex;
    getCurrentSeriesIndexFunc = getCurrentSeriesIndex;

    // 停止现有定时器
    if (speedTestTimer) {
      clearInterval(speedTestTimer);
    }

    // 延迟后开始第一次测速（避免影响页面加载）
    setTimeout(() => {
      testAllChannelSpeeds();
    }, INITIAL_DELAY);

    // 设置定时器，每10分钟执行一次
    speedTestTimer = setInterval(() => {
      testAllChannelSpeeds();
    }, SPEED_UPDATE_INTERVAL);

    console.log('速度测试调度器已启动，每10分钟更新一次');
  }

  // 停止定时测速
  function stopSpeedTestScheduler() {
    if (speedTestTimer) {
      clearInterval(speedTestTimer);
      speedTestTimer = null;
      console.log('速度测试调度器已停止');
    }
  }

  // 重置定时器（用于切换集数后重新计时）
  function resetSpeedTestTimer() {
    if (speedTestTimer) {
      clearInterval(speedTestTimer);
    }

    // 重新设置定时器，10分钟后执行
    speedTestTimer = setInterval(() => {
      testAllChannelSpeeds();
    }, SPEED_UPDATE_INTERVAL);

    console.log('测速定时器已重置，10分钟后执行下次测速');
  }

  // 设置UI更新回调
  function setUpdateCallback(callback) {
    updateCallback = callback;
  }

  // ========== 导出API ==========
  window.SpeedTest = {
    // 数据管理
    getChannelSpeed: getChannelSpeed,

    // 调度器控制
    startSpeedTestScheduler: startSpeedTestScheduler,
    stopSpeedTestScheduler: stopSpeedTestScheduler,
    resetSpeedTestTimer: resetSpeedTestTimer,

    // UI更新回调
    setUpdateCallback: setUpdateCallback,

    // 手动触发测速（可选）
    testAllChannelSpeeds: testAllChannelSpeeds
  };

  console.log('SpeedTest模块已加载');
})();
