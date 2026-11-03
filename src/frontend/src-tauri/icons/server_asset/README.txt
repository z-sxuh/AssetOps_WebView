工作台图标

原图：new_logo.png，由用户提供，保留原始文件。
重新生成：node src/scripts/update-icons.cjs <本机 sharp 模块路径>

生成时提取原图蓝色主体，保留抗锯齿边缘，裁去多余留白后居中；底板保留原图的透明圆角。
浅色：#fcfdfe 底色、#11395c 主体；深色：#3d3a33 底色、#f0ebdd 主体；早春：#f8fcf5 底色、#294b32 主体。

server_asset_app_[light|dark|spring]_[16|24|32|48|64|128|256].png 为带底板图标。
server_asset_taskbar_[light|dark|spring]_[16|32].png 为透明底主体。
server_asset_app_[light|dark|spring].ico 包含 16、24、32、48、64、128、256px；小尺寸使用 BGRA DIB，256px 使用 PNG。

应用内侧栏、启动和锁屏品牌使用 128px PNG；窗口和托盘图标随主题切换，使用 64px PNG。
静态 EXE、快捷方式、安装程序、卸载程序统一使用上级 icons/icon.ico，与浅色多尺寸 ICO 相同。
