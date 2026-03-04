import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * Pixel-accurate iPhone 17 Pro frame.
 *
 * Dimensions based on iPhone 16 Pro (same form factor):
 * - Screen: 393×852 CSS points (2622×1206 @3x)
 * - Corner radius: 55px (device), 50px (screen inner)
 * - Bezel: ~3.5px (thinnest in any iPhone)
 * - Dynamic Island: 126×37 pill, centered 13px from top
 * - Safe area: top 59px, bottom 34px (home indicator)
 * - Frame: natural titanium (#8a8a8e border)
 */

type IPhone17ProFrameProps = {
  children: React.ReactNode;
  /** Disable the spring entrance animation */
  noAnimation?: boolean;
};

// Device dimensions (CSS points)
const SCREEN_W = 393;
const SCREEN_H = 852;
const BEZEL = 4;
const DEVICE_W = SCREEN_W + BEZEL * 2; // 401
const DEVICE_H = SCREEN_H + BEZEL * 2; // 860
const DEVICE_RADIUS = 55;
const SCREEN_RADIUS = 50;

// Dynamic Island
const DI_W = 126;
const DI_H = 37;
const DI_TOP = 13; // from top of screen
const DI_RADIUS = DI_H / 2; // pill shape

export { SCREEN_W, SCREEN_H };

export const IPhone17ProFrame: React.FC<IPhone17ProFrameProps> = ({ children, noAnimation }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = noAnimation
    ? 1
    : spring({ frame, fps, config: { damping: 15, stiffness: 80 } });

  return (
    <div
      style={{
        width: DEVICE_W,
        height: DEVICE_H,
        transform: `scale(${scale})`,
        transformOrigin: 'center center',
        position: 'relative',
      }}
    >
      {/* Titanium frame (outer body) */}
      <div
        style={{
          width: DEVICE_W,
          height: DEVICE_H,
          borderRadius: DEVICE_RADIUS,
          background: '#2c2c2e', // dark titanium
          border: '1.5px solid #48484a', // subtle edge highlight
          boxShadow: [
            '0 2px 4px rgba(0,0,0,0.3)', // close shadow
            '0 12px 40px rgba(0,0,0,0.5)', // mid shadow
            '0 30px 80px rgba(0,0,0,0.4)', // far shadow
            'inset 0 1px 0 rgba(255,255,255,0.05)', // top edge gleam
          ].join(', '),
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Side button (right) — power */}
        <div
          style={{
            position: 'absolute',
            right: -2,
            top: 180,
            width: 3,
            height: 65,
            borderRadius: '0 2px 2px 0',
            background: '#48484a',
          }}
        />

        {/* Side buttons (left) — volume up, down, action */}
        <div
          style={{
            position: 'absolute',
            left: -2,
            top: 140,
            width: 3,
            height: 28,
            borderRadius: '2px 0 0 2px',
            background: '#48484a',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: -2,
            top: 185,
            width: 3,
            height: 50,
            borderRadius: '2px 0 0 2px',
            background: '#48484a',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: -2,
            top: 250,
            width: 3,
            height: 50,
            borderRadius: '2px 0 0 2px',
            background: '#48484a',
          }}
        />

        {/* Screen */}
        <div
          style={{
            position: 'absolute',
            top: BEZEL,
            left: BEZEL,
            width: SCREEN_W,
            height: SCREEN_H,
            borderRadius: SCREEN_RADIUS,
            overflow: 'hidden',
            background: '#000',
          }}
        >
          {/* App content */}
          {children}

          {/* Dynamic Island (on top of everything) */}
          <div
            style={{
              position: 'absolute',
              top: DI_TOP,
              left: (SCREEN_W - DI_W) / 2,
              width: DI_W,
              height: DI_H,
              borderRadius: DI_RADIUS,
              background: '#000',
              zIndex: 50,
            }}
          />
        </div>
      </div>

      {/* Home indicator */}
      <div
        style={{
          position: 'absolute',
          bottom: BEZEL + 8,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 134,
          height: 5,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.2)',
          zIndex: 60,
        }}
      />
    </div>
  );
};
