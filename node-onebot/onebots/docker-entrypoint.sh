#!/bin/sh -e
if [ -z $QQ_Number ]; then
  echo '请添加环境变量QQ_Number'
  exit 1
fi
if [ ! -f /data/config.yaml ]; then
onebots > /dev/null
mv config.yaml /data/config.yaml
fi
sed -i "/123456789/s/123456789/$QQ_Number/" /data/config.yaml

if [ ! -z "$platform" ]; then
  sed -i "/platform/{s/[0-9]/$platform/}" /data/config.yaml
fi
if [ ! -z "$token" ]; then
  sed -i "/access_token/{s/'[^']*'/$token/}" /data/config.yaml
fi
if [ ! -z "$ws_reverse" ]; then
  sed -i "/ws_reverse/s/\[ \]/\[$ws_reverse\]/" /data/config.yaml
fi
if [ ! -z "$onebotVersion" ]; then
  sed -i "/version/s/V\d+/V$onebotVersion/" /data/config.yaml
fi


if [ ! -f /data/${QQ_Number}_token ]; then
  echo "" > /tmp/.input
  if [ ! -z "$QQ_Password" ]; then
    echo '使用密码登录'
    sed -i "/password/s/abcedfghi/$QQ_Password/" /data/config.yaml
  else
    echo '未设置环境变量QQ_Password 使用扫码登录'
    sed -i "/password/d" /data/config.yaml
  fi

  (tail -f /tmp/.input ) | onebots -c /data/config.yaml | tee /tmp/.out &
  kpid=$!

  ok='false'
  if [ ! -z "$QQ_Password" ]; then
     echo "等待程序准备完成"
     sleep 5
     #检查是否需要验证码
     if [ ! -z "$(cat /tmp/.out | grep '验证码')" ]; then
        echo '需要手动验证,请使用docker attach node-onebot开始交互,然后输入ticket的值:'
        while true
        do
          read ticket
          if [ "${#ticket}" -gt 20 ]; then 
            echo "已输入,请稍等"
            break
          else
            echo "输入不合法,重试,请输入ticket的值:"
          fi
        done
        echo $ticket >> /tmp/.input
        sleep 5
        if [ ! -z "$(cat /tmp/.out | grep '登录失败')" ]; then
           echo '密码登录失败,请手动修改配置(/data/config.yaml)后重试'
           exit 1
        else
          ok='true'
        fi
     fi
  fi

  if [ ! 'true' = "$ok" ]; then
    if [ -z "$waitTime" ] ; then
       waitTime=25
    fi
    echo "开始使用二维码登录"
    while [ ! -f /data/${QQ_Number}_token ]
    do
      sleep $waitTime
      echo "\n" >> /tmp/.input
      sleep 1
      echo "等待 $waitTime 秒后将自动回车"
    done
    kill $kpid
    sleep 1
  fi
fi

rm -rf /tmp/*

exec onebots -f /data/config.yaml
