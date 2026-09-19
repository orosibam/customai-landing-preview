/** @type {import('next').NextConfig} */
const nextConfig = {
  // 승인 대시보드는 항상 최신 큐를 보여줘야 한다. 캐시하면 이미 승인한 걸 또 보게 된다.
  experimental: { staleTimes: { dynamic: 0 } },
};

export default nextConfig;
