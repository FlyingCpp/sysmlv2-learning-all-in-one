package EV_C04_L03 {
  item def ElectricalPower {
    attribute voltageV : ScalarValues::Real = 400.0;
    attribute currentA : ScalarValues::Real = 250.0;
    attribute maxPowerKW : ScalarValues::Real = 100.0;
  }

  item def TorqueCommand {
    attribute requestedTorqueNm : ScalarValues::Real = 180.0;
    attribute timestampMs : ScalarValues::Integer = 0;
    attribute priority : ScalarValues::Integer = 1;
  }

  item def CoolantFlow {
    attribute flowRateLpm : ScalarValues::Real = 12.0;
    attribute temperatureC : ScalarValues::Real = 35.0;
    attribute pressureKPa : ScalarValues::Real = 180.0;
  }

  port def PowerPort {
    ref item power : ElectricalPower;
  }

  port def CommandPort {
    ref item command : TorqueCommand;
  }

  port def ThermalPort {
    ref item coolant : CoolantFlow;
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

  interface def BatteryToInverter {
    end source : PowerPort;
    end target : PowerPort;
    flow source.power to target.power;
  }

  interface def ControllerToInverter {
    end source : CommandPort;
    end target : CommandPort;
    flow source.command to target.command;
  }

  interface def BatteryCoolingInterface {
    end source : ThermalPort;
    end target : ThermalPort;
    flow source.coolant to target.coolant;
  }

  part def ElectricVehicle {
    part battery : BatteryPack;
    part inverter : Inverter;
    part controller : VehicleController;
    part cooling : CoolingLoop;

    // TODO 1: 添加高压功率 interface connect usage，绑定电池到逆变器端口。
    // TODO 2: 添加控制命令 interface connect usage，绑定控制器到逆变器端口。
    // TODO 3: 添加电池冷却 interface connect usage，绑定冷却回路到电池端口。
  }

  view def VehicleInterfaceBindingView specializes StandardViewDefinitions::InterconnectionView;
  view vehicleInterfaceBindingView : VehicleInterfaceBindingView {
    expose ElectricVehicle;
    expose BatteryToInverter;
    expose ControllerToInverter;
    expose BatteryCoolingInterface;
  }
}
