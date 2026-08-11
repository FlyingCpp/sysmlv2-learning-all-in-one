package EV_C01_L01 {
  part def BatteryPack;

  // TODO 1: 定义 ElectricVehicle，并加入 battery 的 part usage。
  // TODO 2: 创建 evPrototype 的 part usage，类型为 ElectricVehicle。

  view def FirstPackageBrowserView specializes StandardViewDefinitions::BrowserView;
  view firstPackageBrowserView : FirstPackageBrowserView {
    expose BatteryPack;
    // TODO 3: 添加 ElectricVehicle 的 expose 视图条目。
    // TODO 4: 添加 evPrototype 的 expose 视图条目。
  }
}
