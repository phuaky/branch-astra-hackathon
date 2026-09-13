import assets from 'branch:assets';
import { handleApiRequest } from './index';

interface HostedEnvironment {
  OPENAI_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: HostedEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const origin = request.headers.get('origin');
      const allowedOrigins = [url.origin, 'https://branch-astra-soil-rose.kuan-builds.chatgpt.site'];
      if (origin && !allowedOrigins.includes(origin)) {
        return Response.json({ error: 'Unexpected request origin' }, { status: 403 });
      }
      return handleApiRequest(request, { apiKey: env.OPENAI_API_KEY, allowedOrigins });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = assets[path];
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0)), {
      headers: {
        'Content-Type': asset.contentType,
        'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
