#!/bin/sh -e
if [ -z $QQ_Number ]; then
  echo '请添加环境变量QQ_Number'
  exit 1
fi
if [ ! -f ~/.oicq/config.js ]; then

oicq $QQ_Number > /dev/null &
kpid=$!
sleep 2
kill $kpid

if [ ! -z "$platform" ]; then
  sed -i "/platform/{s/[0-9]/$platform/}" ~/.oicq/config.js
fi
if [ ! -z "$token" ]; then
  sed -i '/access_token/{s/\"[^\"]*\"/\"$token\"/}' ~/.oicq/config.js && sed -i "s/\$token/$token/" ~/.oicq/config.js
fi
if [ ! -z "$post_url" ]; then
  echo $post_url | tr ',' '\n' | xargs -I {} echo '"{}",' | tac | xargs -n1 -I {} sed -i "/post_url/a {}" ~/.oicq/config.js
fi
if [ ! -z "$ws_reverse_url" ]; then
  echo $ws_reverse_url | tr ',' '\n' | xargs -I {} echo '"{}",' | tac | xargs -n1 -I {} sed -i "/ws_reverse_url/a {}" ~/.oicq/config.js
fi

fi

if [ ! -f ~/.oicq/$QQ_Number/token ]; then
  echo "\n" > /tmp/.input
  
  mkdir -p ~/.oicq/$QQ_Number
  mkdir -p /tmp/.oicq
  touch ~/.oicq/$QQ_Number/password
  rm ~/.oicq/$QQ_Number/password
  if [ ! -z "$QQ_Password" ]; then
    echo $QQ_Password > /tmp/.input
    echo '使用密码登录'
  else
    echo '未设置环境变量QQ_Password 使用扫码登录'
    touch ~/.oicq/$QQ_Number/password
  fi

  (tail -f /tmp/.input )| oicq $QQ_Number | tee /tmp/.out &
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
          if [ "" = "$ticket" ]; then
            echo "输入为空,停止等待输入"
            break
          elif [ "${#ticket}" -gt 20 ]; then 
            echo "已输入,请稍等"
            break
          else
            echo "输入不合法,重试,请输入ticket的值:"
          fi
        done
        echo $ticket >> /tmp/.input
        sleep 5
        if [ ! -z "$(cat /tmp/.out | grep '登录失败')" ]; then
           echo '密码登录失败,切换到二维码登录'
           rm ~/.oicq/$QQ_Number/password
           rm ~/.oicq/$QQ_Number/token
           touch ~/.oicq/$QQ_Number/password
           kill $kpid
           echo "\n" > /tmp/.input
           echo '' > /tmp/.out
           (tail -f /tmp/.input )| oicq $QQ_Number | tee /tmp/.out &
           kpid=$!
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
    while [ ! -f ~/.oicq/$QQ_Number/token ]
    do
      sleep $waitTime
      echo "\n" >> /tmp/.input
      sleep 1
      echo "等待 $waitTime 秒后将自动回车"
    done
    kill $kpid
    sleep 1
  fi
  rm /tmp/.input
  rm /tmp/.out
fi

exec oicq $QQ_Number