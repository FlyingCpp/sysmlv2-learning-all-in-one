package EV_C02_L01 {
  part def BatteryCell;

  part def BatteryModule {
    // TODO 1: 在这里添加 cells[12] 的 part usage。
  }

  part def BatteryPack {
    // TODO 2: 在这里添加 modules[8] 的 part usage。
  }

  // TODO 3: 创建 packA 的 part usage，类型为 BatteryPack。

  view def BatteryBomBrowserView specializes StandardViewDefinitions::BrowserView;
  view batteryBomBrowserView : BatteryBomBrowserView {
    expose BatteryCell;
    expose BatteryModule;
    expose BatteryPack;
    // TODO 4: 添加 packA 的 expose 视图条目。
  }
}
