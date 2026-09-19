import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: '쇼핑쇼츠 승인',
  description: '오늘 생성된 쇼츠를 확인하고 배포를 승인합니다.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          background: '#0e0f13',
          color: '#e9eaee',
          fontFamily:
            "'Pretendard', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', system-ui, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
