import React from 'react';
import { useCurrentFrame } from 'remotion';
import { colors, fonts } from '../lib/theme';

type OverlayChar = {
  char: string;
  confirmed: boolean;
};

type TerminalScreenProps = {
  typed: string;
  cursorVisible: boolean;
  overlayChars?: OverlayChar[];
  fontSize?: number;
};

/**
 * Renders a terminal area styled exactly like the real Codeman xterm.js terminal.
 * Background #0d0d0d, Fira Code font, block cursor, Claude Code prompt.
 */
export const TerminalScreen: React.FC<TerminalScreenProps> = ({
  typed,
  cursorVisible,
  overlayChars,
  fontSize = 28,
}) => {
  const frame = useCurrentFrame();

  // Block cursor — solid, no blink (matches Codeman's cursorBlink: false)
  const cursorOn = cursorVisible;
  // But add a subtle blink for video clarity so viewers notice it
  const cursorOpacity = cursorOn ? (Math.floor(frame / 20) % 2 === 0 ? 0.9 : 0.6) : 0;

  const lineHeight = Math.round(fontSize * 1.35);
  const charWidth = fontSize * 0.6;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0d0d0d',
        position: 'relative',
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        overflow: 'hidden',
      }}
    >
      {/* Previous terminal output lines (fake history for realism) */}
      <div
        style={{
          padding: '16px 20px',
          fontSize: fontSize * 0.65,
          lineHeight: `${Math.round(fontSize * 0.65 * 1.4)}px`,
          color: '#495057',
        }}
      >
        <div>
          <span style={{ color: '#339af0' }}>❯</span>
          <span style={{ color: '#495057' }}> claude --dangerously-skip-permissions</span>
        </div>
        <div style={{ color: '#3a3a3a', marginTop: 4 }}>
          ╭────────────────────────────────────╮
        </div>
        <div style={{ color: '#3a3a3a' }}>
          │ Claude Code session active         │
        </div>
        <div style={{ color: '#3a3a3a' }}>
          ╰────────────────────────────────────╯
        </div>
      </div>

      {/* Active prompt line — this is where the typing happens */}
      <div
        style={{
          padding: '8px 20px',
          fontSize,
          lineHeight: `${lineHeight}px`,
          display: 'flex',
          alignItems: 'baseline',
        }}
      >
        {/* Prompt character */}
        <span style={{ color: '#339af0', fontWeight: 700, marginRight: charWidth * 0.8 }}>❯</span>

        {/* Typed text */}
        {overlayChars ? (
          // Zerolag mode: show overlay chars with confirmed/unconfirmed color
          overlayChars.map((oc, i) => (
            <span
              key={i}
              style={{
                color: oc.confirmed ? '#e0e0e0' : '#7a7a7a',
                letterSpacing: '0.5px',
              }}
            >
              {oc.char}
            </span>
          ))
        ) : (
          <span style={{ color: '#e0e0e0', letterSpacing: '0.5px' }}>{typed}</span>
        )}

        {/* Block cursor */}
        <span
          style={{
            display: 'inline-block',
            width: charWidth,
            height: lineHeight * 0.85,
            background: `rgba(224, 224, 224, ${cursorOpacity})`,
            verticalAlign: 'text-bottom',
            marginLeft: 1,
          }}
        />
      </div>
    </div>
  );
};
