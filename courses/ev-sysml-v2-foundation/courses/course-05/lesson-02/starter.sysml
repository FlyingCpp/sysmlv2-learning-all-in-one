package EV_C05_L02 {
  item def ElectricalPower;
  item def ChargeMessage;

  port def PowerPort {
    ref item power : ElectricalPower;
  }

  port def CanPort {
    ref item commSignal : ChargeMessage;
  }

  part def BatteryPack {
    port dcIn : PowerPort;
    port bmsCan : CanPort;
  }

  part def Charger {
    port dcOut : PowerPort;
    port comm : CanPort;
  }

  interface def ChargingPowerInterface {
    end source : PowerPort;
    end target : PowerPort;
    flow source.power to target.power;
  }

  action def ChargingProcess {
    // TODO 1: 添加 in socCurrent、targetSOC 和 out currentSetpointA、chargingComplete。
    // 类型使用 ScalarValues::Real / ScalarValues::Boolean。类型冒号必须用英文半角 ":"。

    action handshakeWithCharger {
      out chargerReady : ScalarValues::Boolean;
    }

    // TODO 2: 添加 then action preChargeCheck，接收 chargerReady 并输出 systemReady。
    // TODO 3: 添加 then action regulateCurrent，接收 systemReady 并输出 currentCommandA。
    // TODO 4: 添加 then action monitorCharge，接收 currentCommandA 并输出 chargingComplete。

    // TODO 5: 添加 chargerReady 到 preChargeCheck.chargerReady 的 flow。
    // TODO 6: 添加 systemReady 到 regulateCurrent.systemReady 的 flow。
    // TODO 7: 添加 currentCommandA 到 monitorCharge.currentCommandA 的 flow。
  }

  view def ChargingFlowView specializes StandardViewDefinitions::ActionFlowView;
  view chargingActionFlowView : ChargingFlowView {
    expose ChargingProcess;
  }

  view def ChargingReviewView specializes StandardViewDefinitions::GeneralView;
  view chargingBehaviorView : ChargingReviewView {
    expose BatteryPack;
    expose Charger;
    // TODO 8: 添加 ChargingProcess 的 expose 视图条目。
  }
}
