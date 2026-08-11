package EV_C04_L02 {
  item def ElectricalPower {
    // TODO 1: 添加 attribute 参数 voltageV、currentA、maxPowerKW。
  }

  item def TorqueCommand {
    // TODO 2: 添加 attribute 参数 requestedTorqueNm、timestampMs、priority。
  }

  item def CoolantFlow {
    // TODO 3: 添加 attribute 参数 flowRateLpm、temperatureC、pressureKPa。
  }

  port def PowerPort {
    ref item power : ElectricalPower;
  }

  port def CommandPort {
    // TODO 4: 添加 ref item，引用通过控制端口交换的 TorqueCommand。
  }

  port def ThermalPort {
    // TODO 5: 添加 ref item，引用通过热管理端口交换的 CoolantFlow。
  }

  part def BatteryPack {
    port dcOut : PowerPort;
    port thermalIn : ThermalPort;
  }

  part def Inverter {
    port dcIn : PowerPort;
    port commandIn : CommandPort;
    port thermalOut : ThermalPort;
  }

  part def VehicleController {
    port commandOut : CommandPort;
  }

  part def CoolingLoop {
    port batterySide : ThermalPort;
  }

  view def MultiFlowInterfaceView specializes StandardViewDefinitions::InterconnectionView;
  view multiFlowInterfaceView : MultiFlowInterfaceView {
    expose BatteryPack;
    expose Inverter;
    expose VehicleController;
    expose CoolingLoop;
    expose PowerPort;
    expose CommandPort;
    expose ThermalPort;
  }
}
