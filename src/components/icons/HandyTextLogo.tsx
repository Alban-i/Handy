import React from "react";

const HandyTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox="0 0 930 328"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="465"
        y="230"
        textAnchor="middle"
        className="logo-primary"
        style={{
          fontSize: "280px",
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontWeight: 700,
          fontStyle: "italic",
          letterSpacing: "-0.02em",
        }}
      >
        Katib
      </text>
    </svg>
  );
};

export default HandyTextLogo;
