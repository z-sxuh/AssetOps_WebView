import { Select } from 'antd';
import { forwardRef, isValidElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ForwardedRef, ReactElement, ReactNode, RefAttributes } from 'react';
import type { SelectProps } from 'antd';
import type { BaseOptionType, DefaultOptionType, RefSelectProps } from 'antd/es/select';

// Preserve virtual lists while allowing content-sized menus to fit near viewport edges.
export const selectPlacements: NonNullable<SelectProps['builtinPlacements']> = {
  bottomLeft: { points: ['tl', 'bl'], offset: [0, 4], overflow: { adjustX: 1, adjustY: 1, shiftX: true, shiftY: true }, htmlRegion: 'scroll' },
  bottomRight: { points: ['tr', 'br'], offset: [0, 4], overflow: { adjustX: 1, adjustY: 1, shiftX: true, shiftY: true }, htmlRegion: 'scroll' },
  topLeft: { points: ['bl', 'tl'], offset: [0, -4], overflow: { adjustX: 1, adjustY: 1, shiftX: true, shiftY: true }, htmlRegion: 'scroll' },
  topRight: { points: ['br', 'tr'], offset: [0, -4], overflow: { adjustX: 1, adjustY: 1, shiftX: true, shiftY: true }, htmlRegion: 'scroll' },
};

// 菜单宽度由 CSS 的 max-content 决定，而虚拟滚动只渲染窗口内的若干项，
// 于是滚动或重新展开时宽度会跟着当前渲染的选项漂移。选项不多时直接整列渲染，
// 让宽度稳定落在最宽的那一项上；超过上限才保留虚拟滚动以控制节点数量。
const virtualThreshold = 200;

const countOptions = (props: SelectProps<any, any>): number => {
  if (Array.isArray(props.options)) {
    return props.options.reduce((total: number, item: unknown) => {
      const nested = (item as { options?: unknown })?.options;
      return total + (Array.isArray(nested) ? nested.length : 1);
    }, 0);
  }
  if (Array.isArray(props.children)) return props.children.length;
  return 0;
};

const labelText = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(labelText).join('')
  : isValidElement<{ children?: ReactNode }>(node) ? labelText(node.props.children) : '';

type ActiveSelectProps<ValueType, OptionType extends BaseOptionType> = SelectProps<ValueType, OptionType> & { active?: boolean };
function AppSelect<ValueType, OptionType extends BaseOptionType = DefaultOptionType>({ active = true, ...props }: ActiveSelectProps<ValueType, OptionType>, ref: ForwardedRef<RefSelectProps>) {
  const virtual = props.virtual ?? countOptions(props) > virtualThreshold;
  const [localOpen, setLocalOpen] = useState(false);
  const [popupWidth, setPopupWidth] = useState<number>();
  const visible = active && (props.open ?? localOpen);
  useLayoutEffect(() => { if (!active) { setLocalOpen(false); (props.onOpenChange ?? props.onDropdownVisibleChange)?.(false); } }, [active]);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const labels = useMemo(() => {
    const result: string[] = [];
    const collect = (options: BaseOptionType[]) => options.forEach(option => {
      result.push(labelText(option[props.fieldNames?.label ?? 'label']) || String(option.value ?? ''));
      const children = option[props.fieldNames?.options ?? 'options'];
      if (Array.isArray(children)) collect(children);
    });
    if (virtual && props.options) collect(props.options);
    return result;
  }, [virtual, props.options, props.fieldNames]);
  const measurePopup = useCallback(() => {
    const element = popupRef.current;
    if (!visible || !element || !labels.length || typeof props.popupMatchSelectWidth === 'number') return;
    const option = element.querySelector<HTMLElement>('.ant-select-item-option-content');
    if (!option) return;
    const typography = getComputedStyle(option);
    const row = getComputedStyle(option.closest('.ant-select-item')!);
    const surface = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${typography.fontStyle} 600 ${typography.fontSize} ${typography.fontFamily}`;
    const spacing = Number.parseFloat(typography.letterSpacing) || 0;
    let width = 0;
    for (const label of labels) width = Math.max(width, context.measureText(label).width + Math.max(0, label.length - 1) * spacing);
    setPopupWidth(Math.ceil(width + Number.parseFloat(row.paddingLeft) + Number.parseFloat(row.paddingRight) + Number.parseFloat(surface.paddingLeft) + Number.parseFloat(surface.paddingRight) + 24));
  }, [visible, labels, props.popupMatchSelectWidth]);
  useLayoutEffect(measurePopup, [measurePopup]);
  const setPopup = useCallback((element: HTMLDivElement | null) => { popupRef.current = element; if (element) measurePopup(); }, [measurePopup]);
  const width = typeof props.popupMatchSelectWidth === 'number' ? props.popupMatchSelectWidth : virtual ? popupWidth : undefined;
  const styles = width === undefined ? props.styles : { ...props.styles, popup: { ...props.styles?.popup, root: { ...props.styles?.popup?.root, '--select-popup-width': `${width}px` } as CSSProperties } };
  return <Select<ValueType, OptionType> {...props} open={visible} styles={styles} virtual={virtual} ref={ref} popupMatchSelectWidth={width ?? props.popupMatchSelectWidth} builtinPlacements={props.builtinPlacements ?? selectPlacements}
    onOpenChange={open => { setLocalOpen(open); (props.onOpenChange ?? props.onDropdownVisibleChange)?.(open); }}
    popupRender={virtual && labels.length ? menu => <div ref={setPopup}>{(props.popupRender ?? props.dropdownRender)?.(menu) ?? menu}</div> : props.popupRender} />;
}

export default forwardRef(AppSelect) as <ValueType, OptionType extends BaseOptionType = DefaultOptionType>(props: ActiveSelectProps<ValueType, OptionType> & RefAttributes<RefSelectProps>) => ReactElement;
