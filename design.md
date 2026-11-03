# 工作台主题与动效规范

配色以 `styles.css` 和 `appTheme.ts` 为准；连续圆角令牌只在 `squircle.css` 定义，旧 WebView 使用 `useSquircle` 绘制同一表面。

## 1. 配色

主题菜单支持跟随系统、晨雾、早春和浅夜。跟随系统保存为 `system`，实际表面根据系统明暗切换。

| 令牌 | 晨雾 | 早春 | 浅夜 |
| --- | --- | --- | --- |
| `--background` | `#f4f6f8` | `#edf4e9` | `#2d2a24` |
| `--surface` | `#fcfdfe` | `#f8fcf5` | `#3d3a33` |
| `--sidebar` | `#e8ecf0` | `#e1eddc` | `#464239` |
| `--table-header` | `#e8ecf0` | `#e1eddc` | `#464239` |
| `--inset` | `#edf0f3` | `#e4efdf` | `#292720` |
| `--ink` | `#303740` | `#293d30` | `#f0ebdd` |
| `--muted` | `#66707b` | `#556b5b` | `#aea99d` |
| `--line` | `#d6dce2` | `#cdddc9` | `#4c483f` |
| `--green` | `#287a54` | `#3c8058` | `#3bb77b` |
| `--blue` | `#287eb2` | `#287eb2` | `#4ca2d5` |

按钮、链接与状态色由 `createAppTheme` 和上述语义令牌共同决定。热力日历使用 `--heat-1..4`，低热度从当前主题的表面色和绿色混合，高热度配套独立文字颜色。

## 2. 表面、边框与阴影

常规边框使用 `--line` 和 `--border-soft`，背景透明比例与现有阴影以 `styles.css`、`floating-surfaces.css` 为准。羽化为 0.5px 与 2px 两层：控件使用 drop-shadow，大容器把羽化叠加到原生阴影中。大容器保留焦点环、滚动条、浮层定位和全屏定位，兼容 Hook 只绘制表面，不裁剪内容。

## 3. 组件圆角

| 类型 | 令牌 | 半径 |
| --- | --- | --- |
| 常规按钮、输入、组合输入、选择触发器 | `--radius-control` | 12px |
| 标签、复选框、紧凑表格控件、菜单项 | `--radius-compact` | 10px |
| 模块、卡片、表格、月历、设置分组 | `--radius-panel` | 16px |
| 下拉、搜索结果、提示浮层 | `--radius-popup` | 14px |
| 弹窗、抽屉、初始化卡片 | `--radius-dialog` | 18px |

这些表面使用 Squircle 与羽化。原生 `corner-shape` 优先，旧 WebView 使用通用兼容 Hook。圆形状态点、头像、开关滑块等保留自身语义形状。拓扑导出仍是历史实现，本轮不审查或修改其几何。

## 4. 字体与尺寸继承

- 首字体为 `Microsoft YaHei UI`，后备依次使用 `Microsoft YaHei`、`Segoe UI` 和系统无衬线字体；全部文字保持正体。
- CSS 根字号为 `14px`，主应用 Ant Design 基础字号为 `13px`；各页面、弹窗、导览及独立搜索保留现有字号与响应式规则。
- 页面标题 `.page-heading h2.ant-typography` 与面板标题 `.panel-card .ant-card-head-title` 使用字重 `700`；组件强调字重令牌为 `600`。
- 统计数值 `.kpi-value`、`.donut b`、`.project-total`、`.maintenance-summary b` 使用 `font-variant-numeric: tabular-nums`，字体家族保持一致。
- 行高、内外边距、模块间距和控件尺寸直接沿用现有组件定义，不另设统一尺寸档位。

## 5. 后续迭代规则与源码入口

- 保留用户亮色／暗色／跟随系统偏好，以及页尾切换保存成功才生效的规则。
- 保留现有侧栏、表格操作栏、浮层定位、搜索、滚动条及减少动态效果规则；调整主题时保持组件布局与交互。
- 修改主题时同步 CSS 与 Ant Design 配色，并覆盖主应用、初始化／解锁和独立桌面搜索。

源码入口：[全局主题与组件样式](src/frontend/src/styles.css)、[主应用主题令牌](src/frontend/src/App.tsx)、[独立搜索主题](src/frontend/src/components/SearchWindow.tsx)。

## 6. 流畅动效基准

- 柔和缓出曲线 `--motion-easing` 沿用 `--sidebar-easing: cubic-bezier(.22, .8, .24, 1)`，一般浮层 `--motion-duration: .2s`，局部按下反馈 `--motion-feedback-duration: .16s`。
- Modal 入场保留 `.28s cubic-bezier(.16, 1, .3, 1)`、14px 位移；首次准备可见并停在起点，active 才过渡。小浮层 `.2s`，定位准备隐藏；同一浮层重复开关接续当前位置，稳定态保留位移合成层和恒定不透明度。
- 退场保留已有短时加速曲线；遮罩保持恒定透明度与模糊，内容完成退场后清理。台账操作栏固定 144px 表面与 128px 文字，不挤压数据列。
- 侧栏 `.38s` 同步宽度，普通展开文字纯淡入，收回裁切与位移；收回途中反向接续当前状态。日历明细 `.28s` 宽度衔接，保留内容到退场结束。
- 导览编辑中的相邻模块用 200ms transform 让位，活动目标直接跟手；键盘和减少动态模式即时更新。图表保留 400ms 填充动画，数字在独立层保持正常形状。
- 顶栏图标、折叠按钮与缩放手柄按下 scale(.97)／160ms，减少动态时保留颜色反馈并取消缩放。页面导航、表格阅读和键盘操作保持即时。
- 减少动态模式下浮层准备／进退场位置均为零，保留 `.01ms` 生命周期结束事件。新增悬停反馈仅精细指针生效。
