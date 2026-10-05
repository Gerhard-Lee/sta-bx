import { defineConfig, loadEnv } from 'vite';

// 这两个变量在源码里是 import.meta.env 常量：构建时缺失会被折叠成 undefined，
// `if (!supabaseUrl || !supabaseKey)` 恒真 → 整个应用被当死代码摇掉，产物只剩"连接暂不可用"
// 的错误壳，而且构建不报错。这里 fail-fast，把静默事故变成一次明确的构建失败。
const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  const value = (key) => String(fileEnv[key] ?? process.env[key] ?? '').trim();
  const missing = REQUIRED.filter((key) => !value(key));
  if (missing.length) {
    throw new Error(
      `缺少构建环境变量：${missing.join('、')}。\n` +
      'Vite 会把它们折叠成 undefined，产物只会渲染"连接暂不可用"的错误壳（且不报错）。\n' +
      '本地：cp .env.example .env 并填值；Vercel/Cloudflare：在项目环境变量里配置这两个键。',
    );
  }
  return {};
});
