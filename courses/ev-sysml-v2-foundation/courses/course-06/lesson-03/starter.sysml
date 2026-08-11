package EV_C06_Structure {
  part def Motor;
  part def Inverter;
  part def ElectricDriveUnit {
    part motor : Motor;
    part inverter : Inverter;
  }
}

package EV_C06_Behavior {
  action def FullTorqueDelivery;
  action def LimitedTorqueDelivery;
  action def MotorShutdownAction;
}

private import EV_C06_Structure::*;
private import EV_C06_Behavior::*;

package EV_C06_States {
  attribute def TorqueCommandSignal;
  attribute def TorqueStoppedSignal;
  attribute def MotorOvertempSignal;
  attribute def MotorTooHotSignal;
  attribute def MotorTempNormalSignal;
  attribute def MotorHardwareFaultSignal;

  state def PropulsionState {
    in motorTempC : ScalarValues::Real;

    first start then Disabled;

    state Disabled;
    state Running {
      state Normal;
      state Degraded {
        state PowerLimit50;
        state LimpHome;
        // 示例: PowerLimit50 -> LimpHome，温度过高时进入跛行回家。
        transition limit50_to_limp first PowerLimit50 accept MotorTooHotSignal if motorTempC > 180.0 then LimpHome;
      }

      // TODO 2: 在 Normal 内添加 do action fullTorque : FullTorqueDelivery。
      // TODO 3: 在 PowerLimit50 内添加 do action limitedTorque : LimitedTorqueDelivery。
      // TODO 4: 添加 Normal -> Degraded.PowerLimit50，事件 MotorOvertempSignal。
      // 条件: motorTempC > 120.0。
      // TODO 5: 添加 Degraded.PowerLimit50 -> Normal，事件 MotorTempNormalSignal。
      // 条件: motorTempC < 100.0。
    }

    state Fault {
      // TODO 8: 添加 entry action shutdown : MotorShutdownAction。
    }

    // TODO 6: 添加 Disabled -> Running.Normal，事件为 TorqueCommandSignal。
    // TODO 7: 添加 Running -> Disabled，事件为 TorqueStoppedSignal。
    // TODO 9: 添加 Running -> Fault，事件为 MotorHardwareFaultSignal。
  }
}

private import EV_C06_States::*;

package EV_C06_Top {
  part driveUnit : ElectricDriveUnit {
    state driveMode : PropulsionState;
  }

  view propulsionStateView : StandardViewDefinitions::GeneralView {
    expose ElectricDriveUnit;
    // TODO 10: 添加 PropulsionState 的 expose 视图条目。
  }

  // 可选对比: StateTransitionView 更聚焦 state、transition、guard 和状态动作。
  // 如果你启用下面这段，也可以把 TODO 10 的 PropulsionState expose 放在这里完成。
  // view propulsionStateTransitionView : StandardViewDefinitions::StateTransitionView {
  //   expose PropulsionState;
  // }
}
