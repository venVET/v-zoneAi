// V-Zone AI - MT5 Bridge EA
// Sends broker-native XAUUSD quote + M5/M15/H1/H4 closed candles to Render.
#property strict
#property version "1.0"

input string BackendURL = "https://v-trade-ai.onrender.com/api/v5/mt5/quote";
input string BridgeAPIKey = "CHANGE_ME";
input string SymbolOverride = "XAUUSD";
input int BarsToSend = 120;
input int SendEverySeconds = 5;

string TFName(ENUM_TIMEFRAMES tf){
   if(tf==PERIOD_M5) return "M5";
   if(tf==PERIOD_M15) return "M15";
   if(tf==PERIOD_H1) return "H1";
   if(tf==PERIOD_H4) return "H4";
   return "";
}

string JsonEscape(string s){
   StringReplace(s,"\\","\\\\");
   StringReplace(s,"\"","\\\"");
   return s;
}

string Num(double v){ return DoubleToString(v,8); }

string BarsJson(ENUM_TIMEFRAMES tf){
   MqlRates r[];
   ArraySetAsSeries(r,true);
   int copied=CopyRates(SymbolOverride,tf,1,BarsToSend,r); // closed candles only
   if(copied<=0) return "[]";
   string out="[";
   for(int i=copied-1;i>=0;i--){
      if(i<copied-1) out+=",";
      out+="{\"t\":"+IntegerToString((long)r[i].time)+
           ",\"o\":"+Num(r[i].open)+
           ",\"h\":"+Num(r[i].high)+
           ",\"l\":"+Num(r[i].low)+
           ",\"c\":"+Num(r[i].close)+
           ",\"v\":"+IntegerToString((long)r[i].tick_volume)+"}";
   }
   out+="]";
   return out;
}

void SendFeed(){
   MqlTick tick;
   if(!SymbolInfoTick(SymbolOverride,tick)){
      Print("[V-ZONE MT5] SymbolInfoTick failed for ",SymbolOverride);
      return;
   }
   double spread=tick.ask-tick.bid;
   string body="{"+
      "\"symbol\":\""+JsonEscape(SymbolOverride)+"\", "+
      "\"bid\":"+Num(tick.bid)+","+
      "\"ask\":"+Num(tick.ask)+","+
      "\"last\":"+Num(tick.last>0?tick.last:(tick.bid+tick.ask)/2.0)+","+
      "\"spread\":"+Num(spread)+","+
      "\"serverTime\":"+IntegerToString((long)TimeCurrent())+","+
      "\"timeframes\":{"+
      "\"M5\":"+BarsJson(PERIOD_M5)+","+
      "\"M15\":"+BarsJson(PERIOD_M15)+","+
      "\"H1\":"+BarsJson(PERIOD_H1)+","+
      "\"H4\":"+BarsJson(PERIOD_H4)+"}"+
      "}";

   char data[];
   StringToCharArray(body,data,0,StringLen(body),CP_UTF8);
   char result[];
   string result_headers;
   string headers="Content-Type: application/json\r\n"+
                  "x-vtrade-key: "+BridgeAPIKey+"\r\n";
   ResetLastError();
   int code=WebRequest("POST",BackendURL,headers,10000,data,result,result_headers);
   if(code==-1){
      Print("[V-ZONE MT5] WebRequest failed. Error=",GetLastError(),
            ". Add https://v-trade-ai.onrender.com to MT5 Tools > Options > Expert Advisors > Allow WebRequest.");
      return;
   }
   string response=CharArrayToString(result,0,-1,CP_UTF8);
   if(code>=200 && code<300)
      Print("[V-ZONE MT5] FEED OK HTTP ",code," | ",response);
   else
      Print("[V-ZONE MT5] FEED ERROR HTTP ",code," | ",response);
}

int OnInit(){
   if(BridgeAPIKey=="" || BridgeAPIKey=="CHANGE_ME"){
      Print("[V-ZONE MT5] Set BridgeAPIKey to the same MT5_BRIDGE_API_KEY used in Render.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(!SymbolSelect(SymbolOverride,true)){
      Print("[V-ZONE MT5] Cannot select symbol: ",SymbolOverride);
      return INIT_FAILED;
   }
   EventSetTimer(MathMax(1,SendEverySeconds));
   Print("[V-ZONE MT5] Started for ",SymbolOverride," -> ",BackendURL);
   SendFeed();
   return INIT_SUCCEEDED;
}

void OnTimer(){ SendFeed(); }
void OnDeinit(const int reason){ EventKillTimer(); }
