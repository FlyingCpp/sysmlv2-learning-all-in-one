package EV_C10_L02 {
  private import EV_C10_Baseline::*;

  attribute def GearDriveSignal;
  attribute def ChargerConnectedSignal;
  attribute def ChargeCompleteSignal;
  attribute def CriticalFaultSignal;

  action def EmergencyShutdown;

  action def DriveCycle {
    in targetSpeedKph : ScalarValues::Real;
    out deliveredTorqueNm : ScalarValues::Real;

    action readDriverDemand {
      out torqueRequestNm : ScalarValues::Real;
    }

    action deliverTorque {
      in torqueRequestNm : ScalarValues::Real;
      out torqueNm : ScalarValues::Real;
    }

    // TODO 1: 添加 flow，连接驾驶需求读取到扭矩输出动作。
  }

  state def VehicleOperatingState {
    in socPercent : ScalarValues::Real;

    first start then Ready;
    state Ready;
    state Driving {
      do action driveControl : DriveCycle;
    }
    state Charging;
    state SafeState {
      entry action emergencyShutdown : EmergencyShutdown;
    }

    // TODO 2: 添加 Ready -> Driving，事件 GearDriveSignal，条件 socPercent > 5.0。
    // TODO 3: 添加 Ready -> Charging，事件 ChargerConnectedSignal。
    // TODO 4: 添加 Charging -> Ready，事件 ChargeCompleteSignal。
    // TODO 5: 添加 Driving -> SafeState，事件 CriticalFaultSignal。
  }

  part def CityVehicle :> ElectricVehicle {
    perform action driveCycle : DriveCycle;
    state operatingState : VehicleOperatingState;
  }

  requirement cityRange : RangeRequirement {
    subject vehicle : ElectricVehicle;
    // TODO 6: 添加 targetRangeKm 的 attribute 重定义，目标值为 480.0。
  }

  part cityVehicle : CityVehicle;
  // TODO 7: 添加 satisfy，说明 cityRange 由 cityVehicle 满足。

  view def IntegrationView specializes StandardViewDefinitions::GeneralView;
  view behaviorStateRequirementView : IntegrationView {
    expose DriveCycle;
    expose VehicleOperatingState;
    // TODO 8: 添加 cityRange 的 expose 视图条目。
    // TODO 9: 添加 cityVehicle 的 expose 视图条目。
  }
}
