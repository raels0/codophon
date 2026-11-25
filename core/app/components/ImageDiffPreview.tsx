import './ImageDiffPreview.css';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/Columns';
import { ImageBrokenIcon as ImageBroken } from '@phosphor-icons/react/ImageBroken';
import { SquareSplitVerticalIcon as SquareSplitVertical } from '@phosphor-icons/react/SquareSplitVertical';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import type {
  ChangedFile,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  ReviewSource,
} from '../../types.ts';

const formatBytes = (size: number) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units.at(-1)) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

type ImagePreviewMode = 'side-by-side' | 'slider';

export function ImageDiffPreview({
  file,
  loadImageContent,
  onLayoutReady,
  section,
  source,
}: {
  file: ChangedFile;
  loadImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  onLayoutReady: (sectionId: string) => void;
  section: DiffSection;
  source: ReviewSource;
}) {
  const loadingResult: DiffImageContentResult = {
    reason: 'Loading image...',
    status: 'unavailable',
  };
  const requestKey = `${file.fingerprint}:${section.id}:${JSON.stringify(source)}`;
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [mode, setMode] = useState<ImagePreviewMode>('slider');
  const sliderStageRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<{
    requestKey: string | null;
    result: DiffImageContentResult;
  }>({
    requestKey: null,
    result: loadingResult,
  });
  const [split, setSplit] = useState(50);
  const result = loadState.requestKey === requestKey ? loadState.result : loadingResult;

  const updateSplitFromClientX = useCallback((clientX: number) => {
    const stage = sliderStageRef.current;
    if (!stage) {
      return;
    }

    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    setSplit(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  }, []);

  const handleDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      updateSplitFromClientX(event.clientX);
    },
    [updateSplitFromClientX],
  );

  const handleDividerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        updateSplitFromClientX(event.clientX);
      }
    },
    [updateSplitFromClientX],
  );

  const handleDividerPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleDividerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      setSplit((current) => Math.max(0, current - (event.shiftKey ? 10 : 2)));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSplit((current) => Math.min(100, current + (event.shiftKey ? 10 : 2)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSplit(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSplit(100);
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    const activeRequestKey = requestKey;

    loadImageContent({
      kind: section.kind,
      path: file.path,
      source,
    })
      .then((nextResult) => {
        if (!canceled) {
          setLoadState({
            requestKey: activeRequestKey,
            result: nextResult,
          });
        }
      })
      .catch(() => {
        if (!canceled) {
          setLoadState({
            requestKey: activeRequestKey,
            result: {
              reason: 'Codophon could not load this image.',
              status: 'unavailable',
            },
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [file.path, loadImageContent, requestKey, section.kind, source]);

  useEffect(() => {
    onLayoutReady(section.id);
  }, [mode, onLayoutReady, result.status, section.id]);

  const handleImageLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const { naturalHeight, naturalWidth } = event.currentTarget;
      if (naturalHeight > 0 && naturalWidth > 0) {
        setAspectRatio(naturalWidth / naturalHeight);
      }
      onLayoutReady(section.id);
    },
    [onLayoutReady, section.id],
  );

  if (result.status === 'unavailable') {
    return (
      <div className="codophon-image-preview codophon-image-preview-message">
        <ImageBroken aria-hidden size={22} weight="duotone" />
        <span>{result.reason}</span>
      </div>
    );
  }

  const { newImage, oldImage } = result;
  const canCompare = Boolean(oldImage && newImage);
  const effectiveMode = canCompare ? mode : 'side-by-side';
  const stageStyle =
    effectiveMode === 'slider'
      ? ({
          '--codophon-image-split': `${split}%`,
          ...(aspectRatio ? { aspectRatio } : {}),
        } as CSSProperties)
      : undefined;

  return (
    <div className="codophon-image-preview">
      <div className="codophon-image-preview-toolbar">
        <span className="codophon-image-preview-title">Image</span>
        {canCompare ? (
          <div className="codophon-image-preview-mode" role="group">
            <button
              aria-label="Slider image comparison"
              aria-pressed={effectiveMode === 'slider'}
              className={effectiveMode === 'slider' ? 'active' : ''}
              onClick={() => setMode('slider')}
              title="Slider"
              type="button"
            >
              <SquareSplitVertical aria-hidden size={16} weight="bold" />
            </button>
            <button
              aria-label="Side-by-side image view"
              aria-pressed={effectiveMode === 'side-by-side'}
              className={effectiveMode === 'side-by-side' ? 'active' : ''}
              onClick={() => setMode('side-by-side')}
              title="Side-by-side"
              type="button"
            >
              <Columns aria-hidden size={16} weight="bold" />
            </button>
          </div>
        ) : null}
      </div>
      {effectiveMode === 'slider' && oldImage && newImage ? (
        <div className="codophon-image-slider">
          <div className="codophon-image-slider-stage" ref={sliderStageRef} style={stageStyle}>
            <img
              alt={`Old ${file.path}`}
              draggable={false}
              onLoad={handleImageLoad}
              src={oldImage.dataUrl}
            />
            <img
              alt={`New ${file.path}`}
              className="codophon-image-slider-new"
              draggable={false}
              onLoad={handleImageLoad}
              src={newImage.dataUrl}
            />
            <div
              aria-label="Image comparison split"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(split)}
              className="codophon-image-slider-divider"
              onKeyDown={handleDividerKeyDown}
              onPointerCancel={handleDividerPointerUp}
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              role="slider"
              tabIndex={0}
            />
          </div>
        </div>
      ) : (
        <div className="codophon-image-grid">
          {oldImage ? (
            <figure>
              <div className="codophon-image-frame">
                <img
                  alt={`Old ${file.path}`}
                  draggable={false}
                  onLoad={handleImageLoad}
                  src={oldImage.dataUrl}
                />
              </div>
              <figcaption>
                <span>Old</span>
                <span>{formatBytes(oldImage.size)}</span>
              </figcaption>
            </figure>
          ) : null}
          {newImage ? (
            <figure>
              <div className="codophon-image-frame">
                <img
                  alt={`New ${file.path}`}
                  draggable={false}
                  onLoad={handleImageLoad}
                  src={newImage.dataUrl}
                />
              </div>
              <figcaption>
                <span>New</span>
                <span>{formatBytes(newImage.size)}</span>
              </figcaption>
            </figure>
          ) : null}
        </div>
      )}
    </div>
  );
}
