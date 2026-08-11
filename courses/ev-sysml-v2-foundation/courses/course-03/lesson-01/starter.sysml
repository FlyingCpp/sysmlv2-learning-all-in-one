package EV_C03_L01 {
  part def Wheel {
    // TODO 1: 增加 Wheel 的 attribute 参数 diameterM 和 massKg。
  }

  part def VehicleBody {
    // TODO 2: 增加 VehicleBody 的 attribute 参数 dragCoeff 和 massKg。
  }

  part def BatteryPack;
  part def Motor;
  part def Controller;

  part def ElectricVehicle {
    part body : VehicleBody;
    part battery : BatteryPack;
    part motor : Motor;
    part controller : Controller;
    part wheels[4] : Wheel;

    // TODO 3: 增加 ElectricVehicle 的 attribute 参数 targetRangeKm。
  }

  view def ParameterGridView specializes StandardViewDefinitions::GridView;
  view parameterGridView : ParameterGridView {
    expose Wheel;
    expose VehicleBody;
    expose BatteryPack;
    expose Motor;
    expose ElectricVehicle;
  }
}
