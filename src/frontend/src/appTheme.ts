import { theme } from 'antd';
import type { ThemeConfig } from 'antd';
import type { Settings } from './model';

export function createAppTheme(name: Exclude<Settings['theme'], 'system'>): ThemeConfig {
  const darkTheme = name === 'dark';
  const springTheme = name === 'spring';
  return ({
    algorithm: darkTheme ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      fontSize: 13, fontFamily: "'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif",
      colorPrimary: darkTheme ? '#3bb77b' : springTheme ? '#3c8058' : '#287a54', colorText: darkTheme ? '#f0ebdd' : springTheme ? '#293d30' : '#303740',
      colorSuccess: darkTheme ? '#3bb77b' : springTheme ? '#3c8058' : '#287a54', colorWarning: darkTheme ? '#f0b044' : '#9e6b16',
      colorError: darkTheme ? '#e56b49' : '#b34f35', colorInfo: darkTheme ? '#4ca2d5' : '#287eb2',
      colorLink: darkTheme ? '#4ca2d5' : '#287eb2', colorLinkHover: darkTheme ? '#74b7dd' : '#226c99',
      colorLinkActive: darkTheme ? '#3d8fbe' : '#1c5c83',
      colorTextSecondary: darkTheme ? '#aea99d' : springTheme ? '#556b5b' : '#66707b', colorTextTertiary: darkTheme ? '#aea99d' : springTheme ? '#556b5b' : '#66707b',
      colorBgLayout: darkTheme ? '#2d2a24' : springTheme ? '#edf4e9' : '#f4f6f8', colorBgContainer: darkTheme ? '#3d3a33' : springTheme ? '#f8fcf5' : '#fcfdfe',
      colorBgElevated: darkTheme ? '#464239' : springTheme ? '#f8fcf5' : '#fcfdfe', colorBorder: darkTheme ? '#4c483f' : springTheme ? '#cdddc9' : '#d6dce2',
      colorBorderSecondary: darkTheme ? '#4c483f' : springTheme ? '#cdddc9' : '#d6dce2', borderRadius: 12, borderRadiusLG: 16,
      borderRadiusSM: 10, controlHeight: 34, fontWeightStrong: 600,
      boxShadow: darkTheme ? '0 8px 32px #00000029' : springTheme ? '0 8px 32px #293d3014' : '0 8px 32px #3037401a',
      boxShadowSecondary: darkTheme ? '0 8px 24px #0000001a' : springTheme ? '0 8px 24px #293d300b' : '0 8px 24px #3037400d',
    },
    components: {
      Table: { headerBg: darkTheme ? '#464239' : springTheme ? '#e1eddc' : '#e8ecf0', headerColor: darkTheme ? '#d3cdbf' : springTheme ? '#46624b' : '#4b5663',
        headerSortActiveBg: darkTheme ? '#292720' : springTheme ? '#e4efdf' : '#edf0f3', headerSortHoverBg: darkTheme ? '#48453d' : springTheme ? '#deebd8' : '#e6eaee',
        headerSplitColor: 'transparent', bodySortBg: darkTheme ? '#3d3a33' : springTheme ? '#f8fcf5' : '#fcfdfe',
        rowHoverBg: darkTheme ? '#48453d' : springTheme ? '#deebd8' : '#e6eaee', rowSelectedBg: darkTheme ? '#34483a' : springTheme ? '#d7e9d3' : '#e2e8ee', fontSize: 13 },
      Card: { headerFontSize: 14, headerHeight: 50 },
      Input: { colorBgContainer: darkTheme ? '#292720' : springTheme ? '#e4efdf' : '#edf0f3' },
      InputNumber: { colorBgContainer: darkTheme ? '#292720' : springTheme ? '#e4efdf' : '#edf0f3' },
      Select: { selectorBg: darkTheme ? '#292720' : springTheme ? '#e4efdf' : '#edf0f3' },
      DatePicker: { colorBgContainer: darkTheme ? '#292720' : springTheme ? '#e4efdf' : '#edf0f3' },
      Button: { borderRadius: 12, borderRadiusSM: 10, borderRadiusLG: 12,
        colorPrimary: darkTheme ? '#f0ebdd' : springTheme ? '#3c8058' : '#287a54', colorPrimaryHover: darkTheme ? '#fff9eb' : springTheme ? '#4b9367' : '#338d63',
        colorPrimaryActive: darkTheme ? '#ddd6c5' : springTheme ? '#326c49' : '#216646', primaryColor: darkTheme ? '#211f19' : springTheme ? '#f8fcf5' : '#ffffff',
        primaryShadow: 'none', defaultShadow: 'none' },
    },
  });
}
