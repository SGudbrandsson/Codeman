import React from 'react';
import { Composition } from 'remotion';
import { CodemanDemo, TOTAL_FRAMES } from './compositions/CodemanDemo';
import { ZerolagDemo, ZEROLAG_TOTAL_FRAMES } from './compositions/ZerolagDemo';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CodemanDemo"
        component={CodemanDemo}
        durationInFrames={TOTAL_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="ZerolagDemo"
        component={ZerolagDemo}
        durationInFrames={ZEROLAG_TOTAL_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
