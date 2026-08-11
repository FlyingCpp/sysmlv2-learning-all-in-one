package EV_C05_L03 {
  part def BatteryPack;
  part def Motor;
  part def BrakeSystem;

  action def RegenerativeBraking {
    // TODO 1: 添加 in 参数 brakeRequest、vehicleSpeedKph、stateOfCharge。
    // TODO 1: 添加 out 参数 recoveredEnergyWh、frictionBrakePressureBar。

    action decideBrakeSplit {
      in brake : ScalarValues::Real;
      in speed : ScalarValues::Real;
      in soc : ScalarValues::Real;
      out regenTorqueNm : ScalarValues::Real;
      out frictionPressureBar : ScalarValues::Real;
    }

    action convertToElectricalPower {
      in torqueNm : ScalarValues::Real;
      out electricalPowerKW : ScalarValues::Real;
    }

    action storeEnergyInBattery {
      in electricalPowerKW : ScalarValues::Real;
      out storedEnergyWh : ScalarValues::Real;
    }

    // TODO 2: 添加 bind，把外层制动输入接入 decideBrakeSplit。
    // TODO 3: 添加 flow，连接 regenTorqueNm 到 torqueNm。
    // TODO 4: 添加 flow，连接 electricalPowerKW 到电池存储输入。
    // TODO 5: 添加 bind，把内部结果接回外层输出参数。
  }

  part def VehicleController {
    // TODO 6: 在控制器中执行 RegenerativeBraking，命名为 regenControl。
  }

  part def ElectricVehicle {
    part controller : VehicleController;
    part motor : Motor;
    part brake : BrakeSystem;
    part battery : BatteryPack;
  }

  view def RegenerativeFlowView specializes StandardViewDefinitions::ActionFlowView;
  view regenActionFlowView : RegenerativeFlowView {
    expose RegenerativeBraking;
  }

  view def RegenerativeReviewView specializes StandardViewDefinitions::GeneralView;
  view regenBehaviorView : RegenerativeReviewView {
    expose ElectricVehicle;
    expose VehicleController;
    // TODO 7: 添加 RegenerativeBraking 的 expose 视图条目。
  }
}
