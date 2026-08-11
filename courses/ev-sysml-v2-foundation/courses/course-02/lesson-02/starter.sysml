package EV_C02_L02 {
  // TODO 1: 定义 ElectricalEnergy（item def）。
  // TODO 2: 定义 TorqueCommand（item def）。

  part def BatteryCell;
  part def BatteryModule {
    part cells[12] : BatteryCell;
  }
  part def BatteryPack {
    part modules[8] : BatteryModule;
    // TODO 3: 在电池包内部创建 storedEnergy 的 item usage。
  }
  part packA : BatteryPack;

  part def Controller {
    // TODO 4: 在控制器内部创建 driveCommand 的 item usage。
  }
  // TODO 5: 创建 vehicleController 的 part usage，类型为 Controller。

  view def ItemUsageReviewView specializes StandardViewDefinitions::GeneralView;
  view itemUsageReviewView : ItemUsageReviewView {
    expose BatteryPack;
    expose packA;
    expose Controller;
    // TODO 6: 添加 ElectricalEnergy 的 expose 视图条目。
    // TODO 7: 添加 TorqueCommand 的 expose 视图条目。
    // TODO 8: 添加 vehicleController 的 expose 视图条目。
  }
}
