package EV_C02_L00 {
  item def ElectricalEnergy;
  item def TorqueCommand;

  part def BatteryCell;
  part def BatteryModule {
    part cells[12] : BatteryCell;
  }
  part def BatteryPack {
    part modules[8] : BatteryModule;
    // TODO 1: 添加 storedEnergy 的 item usage，类型为 ElectricalEnergy。
  }

  part def Controller {
    // TODO 2: 添加 driveCommand 的 item usage，类型为 TorqueCommand。
  }
  part def Inverter;
  part def Motor;
  part def ElectricDriveUnit {
    part inverter : Inverter;
    part motor : Motor;
  }

  part def Vehicle {
    part battery : BatteryPack;
    part controller : Controller;
    part frontDrive : ElectricDriveUnit;
  }
  // TODO 3: 创建 myEV 的 part usage，类型为 Vehicle。

  view def DefinitionUsageOverviewView specializes StandardViewDefinitions::GeneralView;
  view definitionUsageOverviewView : DefinitionUsageOverviewView {
    expose Vehicle;
    expose BatteryPack;
    expose Controller;
    expose ElectricDriveUnit;
    // TODO 4: 添加 myEV 的 expose 视图条目。
  }
}
