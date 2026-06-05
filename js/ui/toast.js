/**
 * iSay Toast 通知系统
 */

import { TIMEOUTS } from '../config.js';

class ToastManager {
  constructor() {
    this.container = null;
  }
  
  /**
   * 获取或创建容器
   * @returns {HTMLElement}
   */
  getContainer() {
    if (!this.container || !this.container.parentNode) {
      this.container = document.createElement("div");
      this.container.id = "toast-container";
      document.body.appendChild(this.container);
    }
    return this.container;
  }
  
  /**
   * 显示 toast 消息
   * @param {string} message
   * @param {number} [duration=3000]
   * @returns {HTMLElement}
   */
  show(message, duration = TIMEOUTS.TOAST_DEFAULT) {
    const container = this.getContainer();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    
    // 触发动画
    requestAnimationFrame(() => toast.classList.add("show"));
    
    // 自动移除
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, duration);
    
    return toast;
  }
  
  /**
   * 清除所有 toast
   */
  clear() {
    const container = this.getContainer();
    container.innerHTML = "";
  }
}

// 单例导出
const toastManager = new ToastManager();

/**
 * 显示 toast 消息的快捷方法
 * @param {string} message
 * @param {number} [duration=3000]
 */
export function showToast(message, duration) {
  return toastManager.show(message, duration);
}

export default toastManager;
export { ToastManager };
