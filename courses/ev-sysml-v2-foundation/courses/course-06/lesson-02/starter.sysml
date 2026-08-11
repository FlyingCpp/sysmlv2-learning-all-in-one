package EV_C06_L02 {
  attribute def DischargeRequestSignal;
  attribute def ChargerConnectedSignal;
  attribute def ChargeTaperSignal;
  attribute def CellVoltageLowSignal;
  attribute def ThermalFaultSignal;
  attribute def FaultClearedSignal;

  action def OpenContactors;
  action def SendFaultReport;
  action def ReenableBattery;

  state def BatteryState {
    in socPercent : ScalarValues::Real;
    in minSocPercent : ScalarValues::Real;
    in packTempC : ScalarValues::Real;
    in maxTempC : ScalarValues::Real;
    in isolationOK : ScalarValues::Boolean;

    first start then Idle;

    state Idle;
    state Active {
      first start then Discharging;

      state Discharging;
      state Charging {
        first start then ConstantCurrent;

        state ConstantCurrent;
        state ConstantVoltage;
        // 示例: ConstantCurrent -> ConstantVoltage，电流开始收敛时转恒压。
        transition cc_to_cv first ConstantCurrent accept ChargeTaperSignal if socPercent > 80.0 then ConstantVoltage;
      }

      // TODO 2: 添加 Discharging -> Charging.ConstantCurrent，事件为 ChargerConnectedSignal。
    }

    state SafeState {
      // TODO 3: 添加 entry action openContactors : OpenContactors。
      // TODO 4: 添加 do action sendFaultReport : SendFaultReport。
      // TODO 5: 添加 exit action reenableBattery : ReenableBattery。
    }

    // 示例: Active.Charging -> SafeState，点号表示 Active 内的 Charging 子状态。
    transition thermal_to_safe first Active.Charging accept ThermalFaultSignal if packTempC > maxTempC then SafeState;
    // TODO 6: 添加 Active.Discharging -> SafeState 的低电量安全转移。
    // 事件 CellVoltageLowSignal；条件 socPercent < minSocPercent。
    // TODO 7: 添加 SafeState -> Idle，事件为 FaultClearedSignal，条件为 isolationOK。
  }

  part def BatteryPack {
    attribute minSocPercent : ScalarValues::Real = 5.0;
    attribute maxTempC : ScalarValues::Real = 60.0;
    state batteryMode : BatteryState;
  }

  view def BatteryStateTransitionView specializes StandardViewDefinitions::StateTransitionView;
  view batteryStateTransitionView : BatteryStateTransitionView {
    expose BatteryState;
  }

  view def BatteryStateCarrierView specializes StandardViewDefinitions::GeneralView;
  view batteryStateCarrierView : BatteryStateCarrierView {
    expose BatteryPack;
    expose BatteryState;
  }
}
