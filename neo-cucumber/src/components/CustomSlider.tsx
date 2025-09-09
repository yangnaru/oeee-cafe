import React from "react";

interface CustomSliderProps {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}

export const CustomSlider: React.FC<CustomSliderProps> = ({
  value,
  min,
  max,
  label,
  onChange,
}) => {
  return (
    <div className="flex flex-col gap-1">
      <div 
        className="relative flex items-center w-full h-8 cursor-pointer"
        style={{
          background: `linear-gradient(to right, var(--main-bg-color) 0%, var(--main-bg-color) ${
            5 + ((value - min) / (max - min)) * 95
          }%, #e5e7eb ${
            5 + ((value - min) / (max - min)) * 95
          }%, #e5e7eb 100%)`,
          border: "1px solid #d1d5db",
        }}
        onMouseDown={(e) => {
          const element = e.currentTarget;
          const updateValue = (clientX: number) => {
            const rect = element.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const newValue = Math.round(min + percent * (max - min));
            const clampedValue = Math.max(min, Math.min(max, newValue));
            onChange(clampedValue);
          };

          updateValue(e.clientX);

          const handleMouseMove = (e: MouseEvent) => {
            updateValue(e.clientX);
          };

          const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
          };

          document.addEventListener('mousemove', handleMouseMove);
          document.addEventListener('mouseup', handleMouseUp);
        }}
        onTouchStart={(e) => {
          const element = e.currentTarget;
          const updateValue = (clientX: number) => {
            const rect = element.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const newValue = Math.round(min + percent * (max - min));
            const clampedValue = Math.max(min, Math.min(max, newValue));
            onChange(clampedValue);
          };

          const touch = e.touches[0];
          updateValue(touch.clientX);

          const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length > 0) {
              updateValue(e.touches[0].clientX);
            }
          };

          const handleTouchEnd = () => {
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
          };

          document.addEventListener('touchmove', handleTouchMove);
          document.addEventListener('touchend', handleTouchEnd);
          e.preventDefault();
        }}
      >
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
          <span
            className="text-sm"
            style={{
              mixBlendMode: "exclusion",
              color: "white",
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
            }}
          >
            {label}
          </span>
        </div>
      </div>
    </div>
  );
};