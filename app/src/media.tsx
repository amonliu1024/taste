import type { CSSProperties, ImgHTMLAttributes } from "react";
import type { AssetRecord } from "./types";

// 素材的显示尺寸：有自动去边裁切框时按裁切后的内容区域，否则按原图。
export function displaySize(asset: AssetRecord): { width: number; height: number } | null {
  if (asset.crop) return { width: asset.crop.width, height: asset.crop.height };
  return asset.width && asset.height ? { width: asset.width, height: asset.height } : null;
}

type CroppedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "className" | "style"> & {
  asset: AssetRecord;
  className?: string;
  // "block"：随容器宽度按裁切比例撑开高度（素材墙）；"contain"：在已定尺寸的容器内等比居中（画布，容器需声明 container-type: size）。
  fit: "block" | "contain";
};

// 预览图和原图共用同一裁切框：用百分比定位，与图片实际分辨率无关。
export function CroppedImage({ asset, className, fit, ...imageProps }: CroppedImageProps) {
  const { crop, width, height } = asset;
  if (!crop || !width || !height) return <img className={className} {...imageProps} />;
  const aspect = crop.width / crop.height;
  // contain 按容器实际尺寸等比适配，与 object-fit: contain 的效果一致。
  const frame: CSSProperties = fit === "contain"
    ? { width: `min(100cqw, calc(100cqh * ${aspect}))`, height: `min(100cqh, calc(100cqw / ${aspect}))` }
    : { aspectRatio: `${crop.width} / ${crop.height}` };
  const image: CSSProperties = {
    width: `${(width / crop.width) * 100}%`,
    height: `${(height / crop.height) * 100}%`,
    left: `${(-crop.x / crop.width) * 100}%`,
    top: `${(-crop.y / crop.height) * 100}%`,
  };
  return (
    <span className={`crop-frame crop-${fit} ${className ?? ""}`} style={frame}>
      <img {...imageProps} style={image} />
    </span>
  );
}
