package EV_C06_L01 {
  attribute def IgnitionOnSignal;
  attribute def GearDriveSignal;
  attribute def GearParkSignal;
  attribute def ChargerConnectedSignal;
  attribute def CriticalFaultSignal;
  attribute def ManualResetSignal;

  action def DriveCycle;
  action def EmergencyShutdown;

  state def VehicleOperatingState {
    in socPercent : ScalarValues::Real;
    in vehicleSpeedKph : ScalarValues::Real;
    in allFaultsCleared : ScalarValues::Boolean;

    first start then Off;

    state Off;
    state Standby;
    state Driving {
      do action driveControl : DriveCycle;
    }
    state Charging;
    // TODO 1: 添加 SafeState，并写 entry action emergencyShutdown : EmergencyShutdown。

    // 示例: Off -> Standby，上电事件为 IgnitionOnSignal。
    transition off_to_standby first Off accept IgnitionOnSignal then Standby;

    // TODO 3: 添加 Standby -> Driving，事件为 GearDriveSignal，条件为 socPercent > 5.0。
    // TODO 4: 添加 Driving -> Standby，事件为 GearParkSignal，条件为 vehicleSpeedKph == 0.0。
    // TODO 5: 添加 Standby -> Charging，事件为 ChargerConnectedSignal。
    // TODO 6: 添加 Driving -> SafeState，事件为 CriticalFaultSignal。
    // TODO 7: 添加 Charging -> SafeState，事件为 CriticalFaultSignal。
    // TODO 8: 添加 SafeState -> Off，事件为 ManualResetSignal，守卫 if allFaultsCleared。
  }

  part def ElectricVehicle {
    state vehicleMode : VehicleOperatingState;
  }

  view vehicleStateView : StandardViewDefinitions::GeneralView {
    expose ElectricVehicle;
    // TODO 9: 添加 VehicleOperatingState 的 expose 视图条目。
  }

  // 可选对比: StateTransitionView 更聚焦 state、transition、guard 和状态动作。
  // 完成本课练习后，可取消注释下面这段，和 GeneralView 的展示内容做对比。
  // view vehicleStateTransitionView : StandardViewDefinitions::StateTransitionView {
  //   expose VehicleOperatingState;
  // }
}
