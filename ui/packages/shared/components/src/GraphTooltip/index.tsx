// Copyright 2022 The Parca Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {CallgraphNode, FlamegraphNode, FlamegraphRootNode} from '@parca/client';
import {getLastItem, valueFormatter} from '@parca/functions';
import {hexifyAddress} from '@parca/profile';
import {useState, useEffect} from 'react';
import {usePopper} from 'react-popper';

interface GraphTooltipProps {
  x: number;
  y: number;
  unit: string;
  total: number;
  hoveringNode: HoveringNode;
  contextElement: Element | null;
  isFixed?: boolean;
  virtualContextElement?: boolean;
}

const virtualElement = {
  getBoundingClientRect: () =>
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    ({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    } as DOMRect),
};

function generateGetBoundingClientRect(contextElement: Element, x = 0, y = 0): () => DOMRect {
  const domRect = contextElement.getBoundingClientRect();
  return () =>
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    ({
      width: 0,
      height: 0,
      top: domRect.y + y,
      left: domRect.x + x,
      right: domRect.x + x,
      bottom: domRect.y + y,
    } as DOMRect);
}

const TooltipMetaInfo = ({hoveringNode}: {hoveringNode: FlamegraphNode}): JSX.Element => {
  if (hoveringNode.meta === undefined) return <></>;

  return (
    <>
      {hoveringNode.meta.function?.filename !== undefined &&
        hoveringNode.meta.function?.filename !== '' && (
          <tr>
            <td className="w-1/5">File</td>
            <td className="w-4/5 break-all">
              {hoveringNode.meta.function.filename}
              {hoveringNode.meta.line?.line !== undefined && hoveringNode.meta.line?.line !== '0'
                ? ` +${hoveringNode.meta.line.line.toString()}`
                : `${
                    hoveringNode.meta.function?.startLine !== undefined &&
                    hoveringNode.meta.function?.startLine !== '0'
                      ? ` +${hoveringNode.meta.function.startLine}`
                      : ''
                  }`}
            </td>
          </tr>
        )}
      {hoveringNode.meta.location?.address !== undefined &&
        hoveringNode.meta.location?.address !== '0' && (
          <tr>
            <td className="w-1/5">Address</td>
            <td className="w-4/5 break-all">
              {' 0x' + hoveringNode.meta.location.address.toString()}
            </td>
          </tr>
        )}
      {hoveringNode.meta.mapping !== undefined && hoveringNode.meta.mapping.file !== '' && (
        <tr>
          <td className="w-1/5">Binary</td>
          <td className="w-4/5 break-all">{getLastItem(hoveringNode.meta.mapping.file)}</td>
        </tr>
      )}
    </>
  );
};

export interface HoveringNode extends CallgraphNode, FlamegraphRootNode {
  diff: string;
  meta?: {[key: string]: any};
}

const GraphTooltipContent = ({
  hoveringNode,
  unit,
  total,
  isFixed,
}: {
  hoveringNode: HoveringNode;
  unit: string;
  total: number;
  isFixed: boolean;
}): JSX.Element => {
  const hoveringNodeCumulative = parseFloat(hoveringNode.cumulative);
  const diff = hoveringNode.diff === undefined ? 0 : parseFloat(hoveringNode.diff);
  const prevValue = hoveringNodeCumulative - diff;
  const diffRatio = Math.abs(diff) > 0 ? diff / prevValue : 0;
  const diffSign = diff > 0 ? '+' : '';
  const diffValueText = diffSign + valueFormatter(diff, unit, 1);
  const diffPercentageText = diffSign + (diffRatio * 100).toFixed(2) + '%';
  const diffText = `${diffValueText} (${diffPercentageText})`;
  const metaRows =
    hoveringNode.meta === undefined ? <></> : <TooltipMetaInfo hoveringNode={hoveringNode} />;

  return (
    <div className={`flex ${isFixed ? 'w-full h-36' : ''}`}>
      <div className={`m-auto w-full ${isFixed ? 'w-full h-36' : ''}`}>
        <div
          className="border-gray-300 dark:border-gray-500 bg-gray-50 dark:bg-gray-900 rounded-lg p-3 shadow-lg opacity-90"
          style={{borderWidth: 1}}
        >
          <div className="flex flex-row">
            <div className="ml-2 mr-6">
              <span className="font-semibold break-all">
                {hoveringNode.meta === undefined ? (
                  <p>root</p>
                ) : (
                  <>
                    {hoveringNode.meta.function !== undefined &&
                    hoveringNode.meta.function.name !== '' ? (
                      <p>{hoveringNode.meta.function.name}</p>
                    ) : (
                      <>
                        {hoveringNode.meta.location !== undefined &&
                        parseInt(hoveringNode.meta.location.address, 10) !== 0 ? (
                          <p>{hexifyAddress(hoveringNode.meta.location.address)}</p>
                        ) : (
                          <p>unknown</p>
                        )}
                      </>
                    )}
                  </>
                )}
              </span>
              <span className="text-gray-700 dark:text-gray-300 my-2">
                <table className="table-fixed">
                  <tbody>
                    <tr>
                      <td className="w-1/5">Cumulative</td>
                      <td className="w-4/5">
                        {valueFormatter(hoveringNodeCumulative, unit, 2)} (
                        {((hoveringNodeCumulative * 100) / total).toFixed(2)}%)
                      </td>
                    </tr>
                    {hoveringNode.diff !== undefined && diff !== 0 && (
                      <tr>
                        <td className="w-1/5">Diff</td>
                        <td className="w-4/5">{diffText}</td>
                      </tr>
                    )}
                    {metaRows}
                  </tbody>
                </table>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const GraphTooltip = ({
  x,
  y,
  unit,
  total,
  hoveringNode,
  contextElement,
  isFixed = false,
  virtualContextElement = true,
}: GraphTooltipProps): JSX.Element => {
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null);

  const {styles, attributes, ...popperProps} = usePopper(
    virtualContextElement ? virtualElement : contextElement,
    popperElement,
    {
      placement: 'auto-start',
      strategy: 'absolute',
      modifiers: [
        {
          name: 'preventOverflow',
          options: {
            tether: false,
            altAxis: true,
          },
        },
        {
          name: 'offset',
          options: {
            offset: [30, 30],
          },
        },
      ],
    }
  );

  const update = popperProps.update;

  useEffect(() => {
    if (contextElement != null) {
      virtualElement.getBoundingClientRect = generateGetBoundingClientRect(contextElement, x, y);
      void update?.();
    }
  }, [x, y, contextElement, update]);

  if (hoveringNode === undefined || hoveringNode == null) return <></>;

  return isFixed ? (
    <GraphTooltipContent hoveringNode={hoveringNode} unit={unit} total={total} isFixed={isFixed} />
  ) : (
    <div ref={setPopperElement} style={styles.popper} {...attributes.popper}>
      <GraphTooltipContent
        hoveringNode={hoveringNode}
        unit={unit}
        total={total}
        isFixed={isFixed}
      />
    </div>
  );
};

export default GraphTooltip;
