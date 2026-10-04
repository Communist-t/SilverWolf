/* live2d-ctrl.js — 银狼 Live2D 渲染与控制（主页面 + 控制页共用）
 * 依赖全局: PIXI (pixi.js)、Live2DCubismCore (live2dcubismcore.min.js)、PIXI.live2d (pixi-live2d-display.cubism4)
 * 通过 BroadcastChannel 实现「控制页 → 主页面」联动。
 */
(function (global) {
  'use strict';
  var CHANNEL = 'silverwolf-live2d';
  var MODEL_URL = '/live2d/%E9%93%B6%E7%8B%BC/%E9%93%B6%E7%8B%BC.model3.json';

  function Live2DApp() {
    this.ready = false;
    this.model = null;
    this.app = null;
    this.container = null;
    this._fitScale = 0.5;
    this._center = { x: 0, y: 0 };
    this._state = { expr:null, motion:null, scaleMul:1, offsetX:0, offsetY:0 };
    try {
      var saved = global.localStorage && global.localStorage.getItem('silverwolf-live2d-state');
      if (saved) { var o = JSON.parse(saved); for (var k in this._state) { if (o[k] != null) { this._state[k] = o[k]; } } }
    } catch (e) {}
    var self = this;
    try {
      this.bc = new BroadcastChannel(CHANNEL);
      this.bc.onmessage = function (e) { self._handle(e.data); };
    } catch (e) {
      this.bc = null;
    }
  }

  /* 初始化：把模型渲染进 containerId 元素 */
  Live2DApp.prototype.init = function (containerId, opts) {
    var self = this;
    opts = opts || {};
    return new Promise(function (resolve) {
      var el = document.getElementById(containerId);
      if (!el || !global.PIXI || !global.PIXI.live2d) { resolve(false); return; }
      self.container = el;
      var w = el.clientWidth || 320;
      var h = el.clientHeight || 400;
      var app = new PIXI.Application({
        width: w, height: h,
        backgroundAlpha: 0, antialias: true, autoDensity: true,
        resolution: global.devicePixelRatio || 1, autoStart: true
      });
      self.app = app;
      el.appendChild(app.view);
      app.view.style.width = '100%';
      app.view.style.height = '100%';
      app.view.style.display = 'block';

      PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: !!opts.autoInteract })
        .then(function (model) {
          self.model = model;
          app.stage.addChild(model);
          self.ready = true;
          // 模型包围盒要等纹理/内核就绪才稳定，用重试适配
          var tries = 0;
          function tryFit() {
            var ok = self._fit();
            tries++;
            if (!ok && tries < 20) { setTimeout(tryFit, 250); }
            else { self._restore(true); if (self.onReady) { self.onReady(); } }
          }
          setTimeout(tryFit, 250);
          if (self.onReady) { self.onReady(); }
          resolve(true);
        })
        .catch(function (err) {
          console.error('[Live2D] 模型加载失败', err);
          resolve(false);
        });
    });
  };

  /* 让模型整体放入容器并按视觉中心居中；成功返回 true，包围盒未就绪返回 false */
  Live2DApp.prototype._fit = function () {
    var m = this.model, el = this.container;
    if (!m || !el) return false;
    var cw = el.clientWidth, ch = el.clientHeight;
    if (!cw || !ch) return false;
    var b;
    try { b = m.getLocalBounds(); } catch (e) { return false; }
    if (!b || !isFinite(b.width) || !isFinite(b.height) || b.width <= 0 || b.height <= 0) return false;
    var s = Math.min(cw / b.width, ch / b.height) * 1.84;
    if (!isFinite(s) || s <= 0) s = 0.5;
    /* 模型原点在视觉左上角：把视觉中心对齐画布中心 */
    var ccx = b.x + b.width / 2, ccy = b.y + b.height / 2;
    m.scale.set(s, s);
    m.position.set(cw / 2 - ccx * s, ch / 2 - ccy * s);
    this._fitScale = s;
    this._center = { x: m.position.x, y: m.position.y };
    return true;
  };

  Live2DApp.prototype.getFitScale = function () { return this._fitScale || 0.5; };

  Live2DApp.prototype.setExpression = function (name) {
    if (name) { this._state.expr = name; this._persist(); }
    if (this.model && name) { try { this.model.expression(name); } catch (e) {} }
  };
  /* 判断是否为"睡觉动画"：它在 TapBody 组第 3 个（变身1=0 / 变身2=1 / 睡觉=2） */
  Live2DApp.prototype._isSleepMotion = function (group, index) {
    return group === 'TapBody' && index === 2;
  };
  /* 睡觉时挂起自动眨眼，避免眨眼把闭眼睡脸强行"睁开"成清醒脸（表现为突然换脸又换回来） */
  Live2DApp.prototype._setEyeBlink = function (on) {
    if (!this.model || !this.model.internalModel) return;
    try {
      var im = this.model.internalModel;
      if (!on && im.eyeBlink && !this._savedEyeBlink) {
        this._savedEyeBlink = im.eyeBlink;
        im.eyeBlink = null;
      } else if (on && !im.eyeBlink && this._savedEyeBlink) {
        im.eyeBlink = this._savedEyeBlink;
        this._savedEyeBlink = null;
      }
    } catch (e) {}
  };
  Live2DApp.prototype.playMotion = function (group, index) {
    if (group != null && index != null) { this._state.motion = { group: group, index: index }; this._persist(); }
    if (this.model && group != null && index != null) {
      this._setEyeBlink(!this._isSleepMotion(group, index));
      try { this.model.motion(group, index, 3); } catch (e) {}
    }
  };
  /* 缩放：multiplier 相对 fitScale */
  Live2DApp.prototype.setScaleMul = function (m) {
    this._state.scaleMul = m; this._persist();
    if (this.model) { try { this.model.scale.set(this._fitScale * m, this._fitScale * m); } catch (e) {} }
  };
  /* 平移：offsetPx 相对中心（x 右 / y 下为正） */
  Live2DApp.prototype.setOffset = function (x, y) {
    this._state.offsetX = x || 0; this._state.offsetY = y || 0; this._persist();
    if (this.model) {
      try { this.model.position.set(this._center.x + (x || 0), this._center.y + (y || 0)); } catch (e) {}
    }
  };
  Live2DApp.prototype.reset = function () {
    this._state = { expr:null, motion:null, scaleMul:1, offsetX:0, offsetY:0 };
    this._persist();
    this._setEyeBlink(true);
    this._fit();
  };

  /* 持久化当前状态到 localStorage（主页面与控制页同源共享） */
  Live2DApp.prototype._persist = function () {
    try {
      if (global.localStorage) { global.localStorage.setItem('silverwolf-live2d-state', JSON.stringify(this._state)); }
    } catch (e) {}
  };
  /* 模型就绪后按上次状态恢复：动作 → 表情 → 缩放位移 */
  Live2DApp.prototype._restore = function (idleFallback) {
    var st = this._state;
    if (st.motion && st.motion.group != null && st.motion.index != null) {
      try { this.playMotion(st.motion.group, st.motion.index); } catch (e) {}
    } else if (idleFallback) {
      try { this.playMotion('Idle', 0); } catch (e) {}
    }
    if (st.expr) { try { this.setExpression(st.expr); } catch (e) {} }
    this.setScaleMul(st.scaleMul != null ? st.scaleMul : 1);
    this.setOffset(st.offsetX || 0, st.offsetY || 0);
  };

  /* 停止当前动作（如睡觉），复位睡眠相关参数并回到清醒待机 */
  Live2DApp.prototype.stopAll = function () {
    if (!this.model) return;
    try { this.model.internalModel.motionManager.stopAllMotions(); } catch (e) {}
    this._setEyeBlink(true);
    try {
      var core = this.model.internalModel.coreModel;
      ["Param150","Param151","Param152","Param153","Param154","ParamMouthOpenY"].forEach(function (id) {
        var idx = core.getParameterIndex(id);
        if (idx >= 0) core.setParameterValueByIndex(idx, 0);
      });
      ["ParamEyeLOpen","ParamEyeROpen"].forEach(function (id) {
        var idx = core.getParameterIndex(id);
        if (idx >= 0) core.setParameterValueByIndex(idx, 1);
      });
    } catch (e) {}
    try { this.model.motion('Idle', 0, 3); } catch (e) {}
  };

  /* 主页面在收到控制页消息时应用 */
  Live2DApp.prototype._handle = function (d) {
    if (!d || !this.ready) return;
    switch (d.type) {
      case 'expr': this.setExpression(d.value); break;
      case 'motion': this.playMotion(d.group, d.index); break;
      case 'scaleMul': this.setScaleMul(d.value); break;
      case 'offset': this.setOffset(d.x, d.y); break;
      case 'reset': this.reset(); break;
      case 'stopAll': this.stopAll(); break;
      default: break;
    }
  };
  /* 控制页发送命令给主页面（本端不会收到自己的消息） */
  Live2DApp.prototype.send = function (cmd) {
    if (this.bc) { try { this.bc.postMessage(cmd); } catch (e) {} }
  };

  global.Live2DApp = new Live2DApp();

  /* 主页面自动初始化：检测到 #live2d-stage 即渲染模型（控制页使用独立容器，不受影响） */
  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('live2d-stage')) {
      global.Live2DApp.init('live2d-stage', { idle: true });
    }
  });

  /* 窗口尺寸变化时重新适配居中 */
  if (global.addEventListener) {
    global.addEventListener('resize', function () {
      if (global.Live2DApp && global.Live2DApp.container) {
        global.Live2DApp._fit();
      }
    });
  }
})(window);
