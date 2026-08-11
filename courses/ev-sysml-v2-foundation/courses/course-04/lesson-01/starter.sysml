package EV_C04_L01 {
  item def ElectricalPower;

  port def PowerPort {
    // TODO 1: 添加 ref item，引用通过功率端口交换的 ElectricalPower。
  }

  part def BatteryPack {
    // TODO 2: 添加 BatteryPack 的 port usage dcOut。
  }

  part def Inverter {
    // TODO 3: 添加 Inverter 的 port usage dcIn。
  }

  part def ElectricVehicle {
    part battery : BatteryPack;
    part inverter : Inverter;
  }

  interface def BatteryToInverter {
    end source : PowerPort;
    end target : PowerPort;
    // TODO 4: 添加 flow，声明 source.power 到 target.power 的功率流向。
  }

  view def PowerInterfaceView specializes StandardViewDefinitions::InterconnectionView;
  view powerInterfaceView : PowerInterfaceView {
    expose ElectricVehicle;
    expose BatteryToInverter;
    expose PowerPort;
    expose ElectricalPower;
  }
}
