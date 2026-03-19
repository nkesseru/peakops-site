"use client";

import dynamic from "next/dynamic";
import React from "react";

const ReactJson = dynamic(() => import("react-json-view"), { ssr: false });

export default function JsonViewer({
  value,
  collapsed = 1,
  name = false,
  style,
}: {
  value: any;
  collapsed?: boolean | number;
  name?: false | string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...style }}>
      <ReactJson
        src={value ?? {}}
        name={name}
        collapsed={collapsed}
        enableClipboard={true}
        displayDataTypes={false}
        displayObjectSize={false}
        indentWidth={2}
        collapseStringsAfterLength={80}
        style={{
          background: "transparent",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.4,
        }}
        theme="monokai"
      />
    </div>
  );
}
