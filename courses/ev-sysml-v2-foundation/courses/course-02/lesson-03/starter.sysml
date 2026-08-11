package EV_C02_L03 {
  item def ElectricalEnergy;
  item def TorqueCommand;

  part def BatteryCell;
  part def BatteryModule {
    part cells[12] : BatteryCell;
  }
  part def BatteryPack {
    part modules[8] : BatteryModule;
    item storedEnergy : ElectricalEnergy;
  }
  part packA : BatteryPack;

  part def Controller {
    item driveCommand : TorqueCommand;
  }
  part vehicleController : Controller;

  part def Motor;
  part def Inverter;
  part def ElectricDriveUnit {
    // TODO 1: 创建 inverter 的 part usage。
    // TODO 2: 创建 motor 的 part usage。
  }

  // TODO 3: 创建 frontDriveUnit 的 part usage。

  // 挑战: 定义 Vehicle，并把 battery、controller、frontDrive 组合进去。

  view def DriveUnitStructureView specializes StandardViewDefinitions::GeneralView;
  view driveUnitStructureView : DriveUnitStructureView {
    expose ElectricDriveUnit;
    expose Inverter;
    expose Motor;
    expose Controller;
    // TODO 4: 添加 frontDriveUnit 的 expose 视图条目。
  }
}
