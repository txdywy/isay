/**
 * iSay Service Worker
 * 网络优先策略，离线时回退到缓存
 */

const CACHE_NAME = 'isay-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/favicon.svg',
  '/manifest.json',
];

// 安装 - 预缓存静态资源
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 激活 - 清理旧缓存
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截 - 网络优先
self.addEventListener("fetch", (event) => {
  // 只处理 GET 请求
  if (event.request.method !== "GET") return;
  
  // 跳过非同源请求（如 CDN）
  if (!event.request.url.startsWith(self.location.origin)) {
    // 对于 CDN 资源，使用缓存优先策略
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          const cache = caches.open(CACHE_NAME);
          cache.then((c) => c.put(event.request, response.clone()));
          return response;
        });
      })
    );
    return;
  }
  
  // 同源资源 - 网络优先
  event.respondWith(
    fetch(event.request, { cache: "no-store" }).catch(() => {
      return caches.match(event.request);
    })
  );
});

// 消息处理
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
