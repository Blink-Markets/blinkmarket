import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <svg width="180" height="180" viewBox="0 0 64 64">
        <rect width="64" height="64" rx="14" fill="#2148B8" />
        <path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z" fill="none" stroke="#FAFAF7" strokeWidth="4.5" strokeLinejoin="round" />
        <circle cx="32" cy="32" r="9.5" fill="#FAFAF7" />
        <circle cx="35.5" cy="28.5" r="2.6" fill="#C65F38" />
      </svg>
    ),
    { ...size },
  );
}
